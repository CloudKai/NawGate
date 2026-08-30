import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalService } from "./agentgate/approval-service.js";
import { AuditService } from "./agentgate/audit-service.js";
import { DeterministicPolicyEngine } from "./agentgate/policy-engine.js";
import { ProtectedResourceService } from "./agentgate/protected-resource-service.js";
import { RuntimeCredentialService } from "./agentgate/runtime-credential-service.js";
import { RuntimeGateway } from "./agentgate/runtime-gateway.js";
import { createApp, type RuntimeApiDependencies } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";
import { HttpError } from "./errors.js";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];
const applications: { close: () => Promise<unknown> }[] = [];
const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
  getAgent: (_id: string, actor: { id: string }) => {
    if (actor.id !== "user-a") throw new HttpError(404, "Agent not found");
    return { ownerUserId: "user-a" };
  },
} as unknown as AgentService;

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeRuntimeApp(): Promise<{
  app: Awaited<ReturnType<typeof createApp>>;
  runtime: RuntimeApiDependencies;
  resources: ProtectedResourceService;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "agentgate-runtime-api-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const audit = new AuditService(store);
  const approvals = new ApprovalService(store, audit);
  const resources = new ProtectedResourceService(store);
  const credentials = new RuntimeCredentialService();
  const runtime: RuntimeApiDependencies = {
    credentials,
    approvals,
    audit,
    gateway: new RuntimeGateway(
      new DeterministicPolicyEngine(),
      resources,
      audit,
      approvals,
      store,
    ),
  };
  const app = await createApp(
    loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "outer-token-for-tests" }),
    service,
    undefined,
    runtime,
  );
  applications.push(app);
  return { app, runtime, resources };
}

function runtimeHeaders(token: string) {
  return { "x-agentgate-runtime": token };
}

describe("Runtime API boundary", () => {
  it("skips browser auth for runtime requests but still requires a valid runtime credential", async () => {
    const { app, runtime } = await makeRuntimeApp();
    const missing = await app.inject({
      method: "POST",
      url: "/api/runtime/actions",
      payload: {
        requestId: "4d1d6f6c-76a9-4c0e-a1ef-f4ecf4f1dfb2",
        action: "resource.read",
        resourceId: "project-a",
      },
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({
      code: "INVALID_RUNTIME_CREDENTIAL",
    });

    const issued = runtime.credentials.issue("agent-a", "run-a", "user-a");
    const allowed = await app.inject({
      method: "POST",
      url: "/api/runtime/actions",
      headers: runtimeHeaders(issued.token),
      payload: {
        requestId: "4d1d6f6c-76a9-4c0e-a1ef-f4ecf4f1dfb2",
        action: "resource.read",
        resourceId: "project-a",
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      status: "success",
      action: "resource.read",
      resourceId: "project-a",
    });

    const crossUser = await app.inject({
      method: "POST",
      url: "/api/runtime/actions",
      headers: runtimeHeaders(issued.token),
      payload: {
        requestId: "f1b5ddc5-d5f6-46f6-aaf5-1f9f0e9d0aa1",
        action: "resource.read",
        resourceId: "project-b",
      },
    });
    expect(crossUser.statusCode).toBe(403);
    expect(crossUser.json()).toMatchObject({
      status: "denied",
      code: "ACTION_NOT_PERMITTED",
    });
    expect(JSON.stringify(crossUser.json())).not.toContain("User B");

    const credentialInResourceId = await app.inject({
      method: "POST",
      url: "/api/runtime/actions",
      headers: runtimeHeaders(issued.token),
      payload: {
        requestId: "9b7f2d53-45a1-4f91-93bb-1e0a4f8c7d2e",
        action: "resource.read",
        resourceId: issued.token,
      },
    });
    expect(credentialInResourceId.statusCode).toBe(403);
    expect(JSON.stringify(credentialInResourceId.json())).not.toContain(issued.token);
    expect(JSON.stringify(runtime.audit.list("agent-a"))).not.toContain(issued.token);

    const runtimeIsNotHumanAuth = await app.inject({
      method: "GET",
      url: "/api/demo/me",
      headers: {
        authorization: "Bearer outer-token-for-tests",
        ...runtimeHeaders(issued.token),
      },
    });
    expect(runtimeIsNotHumanAuth.statusCode).toBe(401);
  });

  it("keeps production pending until the owner approves, then accepts the exact retry", async () => {
    const { app, runtime, resources } = await makeRuntimeApp();
    const issued = runtime.credentials.issue("agent-a", "run-production", "user-a");
    const requestId = "a2b8d9c1-6761-4d72-bf65-77e1f6c7d2c0";
    const initial = await app.inject({
      method: "POST",
      url: "/api/runtime/actions",
      headers: runtimeHeaders(issued.token),
      payload: {
        requestId,
        action: "deploy.production",
        resourceId: "production",
      },
    });
    expect(initial.statusCode).toBe(202);
    const { approvalId } = initial.json() as { approvalId: string };

    const pending = await app.inject({
      method: "GET",
      url: "/api/runtime/approvals/" + approvalId,
      headers: runtimeHeaders(issued.token),
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({ status: "pending", approvalId });
    expect(resources.getDeploymentState("production", "production")?.deploymentCount).toBe(0);

    await runtime.approvals.approve(approvalId, "user-a");
    const approved = await app.inject({
      method: "GET",
      url: "/api/runtime/approvals/" + approvalId,
      headers: runtimeHeaders(issued.token),
    });
    expect(approved.json()).toEqual({ status: "approved", approvalId });

    const retried = await app.inject({
      method: "POST",
      url: "/api/runtime/actions",
      headers: runtimeHeaders(issued.token),
      payload: {
        requestId,
        action: "deploy.production",
        resourceId: "production",
        approvalId,
      },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ status: "success" });
    expect(resources.getDeploymentState("production", "production")?.deploymentCount).toBe(1);
  });

  it("rejects identity fields in runtime action bodies", async () => {
    const { app, runtime } = await makeRuntimeApp();
    const issued = runtime.credentials.issue("agent-a", "run-a", "user-a");
    const forged = await app.inject({
      method: "POST",
      url: "/api/runtime/actions",
      headers: runtimeHeaders(issued.token),
      payload: {
        requestId: "8a5c1c41-35b7-401f-91d5-8e5f21d2f8bb",
        action: "resource.read",
        resourceId: "project-a",
        ownerUserId: "user-b",
      },
    });
    expect(forged.statusCode).toBe(400);
  });

  it("exposes approvals and audit only through the current human owner", async () => {
    const { app, runtime } = await makeRuntimeApp();
    const agentId = "00000000-0000-4000-8000-000000000001";
    const issued = runtime.credentials.issue(agentId, "run-human-api", "user-a");
    const requestId = "de4a7b20-f047-4d9b-a5c7-69b693b67f61";
    const pending = await runtime.gateway.execute(
      { humanId: "user-a", agentId, runId: "run-human-api" },
      { requestId, action: "deploy.production", resourceId: "production" },
    );
    if (pending.status !== "approval_required") throw new Error("Expected pending approval");

    const authHeaders = { authorization: "Bearer outer-token-for-tests" };
    const actorASession = await app.inject({
      method: "POST",
      url: "/api/demo/session",
      headers: authHeaders,
      payload: { userId: "user-a" },
    });
    const actorAToken = (actorASession.json() as { sessionToken: string }).sessionToken;
    const approvals = await app.inject({
      method: "GET",
      url: "/api/agents/" + agentId + "/approvals?status=pending",
      headers: { ...authHeaders, "x-agentgate-session": actorAToken },
    });
    expect(approvals.statusCode).toBe(200);
    expect(approvals.json()).toMatchObject({
      approvals: [{ id: pending.approvalId, action: "deploy.production" }],
    });

    const audit = await app.inject({
      method: "GET",
      url: "/api/agents/" + agentId + "/audit?limit=10",
      headers: { ...authHeaders, "x-agentgate-session": actorAToken },
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "policy.approval_required" }),
      ]),
    );

    const actorBSession = await app.inject({
      method: "POST",
      url: "/api/demo/session",
      headers: authHeaders,
      payload: { userId: "user-b" },
    });
    const actorBToken = (actorBSession.json() as { sessionToken: string }).sessionToken;
    const wrongOwner = await app.inject({
      method: "POST",
      url: "/api/approvals/" + pending.approvalId + "/approve",
      headers: { ...authHeaders, "x-agentgate-session": actorBToken },
    });
    expect(wrongOwner.statusCode).toBe(403);
    expect(wrongOwner.json()).toMatchObject({ code: "APPROVAL_NOT_OWNED" });

    const runtimeCannotApprove = await app.inject({
      method: "POST",
      url: "/api/approvals/" + pending.approvalId + "/approve",
      headers: runtimeHeaders(issued.token),
    });
    expect(runtimeCannotApprove.statusCode).toBe(401);

    const approved = await app.inject({
      method: "POST",
      url: "/api/approvals/" + pending.approvalId + "/approve",
      headers: { ...authHeaders, "x-agentgate-session": actorAToken },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ approval: { status: "approved" } });
  });
});

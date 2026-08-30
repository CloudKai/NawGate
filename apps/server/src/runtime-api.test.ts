import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalService } from "./agentgate/approval-service.js";
import { AgentTeamGrantService } from "./agentgate/agent-team-grant-service.js";
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
const agentAId = "00000000-0000-4000-8000-000000000001";
const runAId = "00000000-0000-4000-8000-000000000002";
const agentBId = "00000000-0000-4000-8000-000000000003";
const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
  getAgent: (_id: string, actor: { id: string }) => {
    if (actor.id !== "user-a") throw new HttpError(404, "Agent not found");
    return { ownerUserId: "user-a" };
  },
  getActiveRun: () => ({
    id: runAId,
    agentId: agentAId,
    status: "running",
  }),
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
  store: JsonStore;
  grants: AgentTeamGrantService;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "agentgate-runtime-api-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const timestamp = "2026-08-30T00:00:00.000Z";
  await store.mutate((database) => {
    database.agents.push(
      {
        id: agentAId,
        ownerUserId: "user-a",
        name: "Agent A",
        description: "",
        instructions: "",
        status: "ready",
        workspacePath: path.join(root, "agent-a"),
        codexThreadId: null,
        lastError: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: agentBId,
        ownerUserId: "user-b",
        name: "Agent B",
        description: "",
        instructions: "",
        status: "ready",
        workspacePath: path.join(root, "agent-b"),
        codexThreadId: null,
        lastError: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    );
  });
  const audit = new AuditService(store);
  const approvals = new ApprovalService(store, audit);
  const resources = new ProtectedResourceService(store);
  const credentials = new RuntimeCredentialService();
  const grants = new AgentTeamGrantService(store, approvals, credentials, audit);
  const runtime: RuntimeApiDependencies = {
    credentials,
    approvals,
    audit,
    grants,
    gateway: new RuntimeGateway(
      new DeterministicPolicyEngine(),
      resources,
      audit,
      approvals,
      store,
      undefined,
      grants,
      credentials,
    ),
  };
  const app = await createApp(
    loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "outer-token-for-tests" }),
    service,
    undefined,
    runtime,
  );
  applications.push(app);
  return { app, runtime, resources, store, grants };
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
        humanId: "user-b",
        agentId: "forged-agent",
        runId: "forged-run",
      },
    });
    expect(forged.statusCode).toBe(400);
  });

  it("routes team-file reads through the runtime credential and rejects the wrong team", async () => {
    const { app, runtime, resources, grants } = await makeRuntimeApp();
    await grants.enroll(
      agentAId,
      { teamId: "team-alpha", role: "viewer" },
      { id: "user-a", name: "User A" },
    );
    const viewer = runtime.credentials.issue(agentAId, "run-team-a", "user-a");
    const internal = await app.inject({
      method: "POST",
      url: "/api/runtime/actions",
      headers: runtimeHeaders(viewer.token),
      payload: {
        requestId: "6f4e5d3c-2b1a-4908-8765-43210fedcba9",
        action: "file.read",
        resourceId: "team-alpha-internal",
      },
    });
    expect(internal.statusCode).toBe(200);
    expect(internal.json()).toMatchObject({
      status: "success",
      action: "file.read",
      resourceId: "team-alpha-internal",
      result: { content: "Synthetic internal Team Alpha file." },
    });

    const restricted = await app.inject({
      method: "POST",
      url: "/api/runtime/actions",
      headers: runtimeHeaders(viewer.token),
      payload: {
        requestId: "af4e5d3c-2b1a-4908-8765-43210fedcba9",
        action: "file.read",
        resourceId: "team-alpha-restricted",
      },
    });
    expect(restricted.statusCode).toBe(403);
    expect(restricted.json()).toMatchObject({
      status: "denied",
      reasonCode: "agent_grant_role_insufficient",
    });

    const wrongTeam = await app.inject({
      method: "POST",
      url: "/api/runtime/actions",
      headers: runtimeHeaders(viewer.token),
      payload: {
        requestId: "7f4e5d3c-2b1a-4908-8765-43210fedcba9",
        action: "file.read",
        resourceId: "team-beta-internal",
      },
    });
    expect(wrongTeam.statusCode).toBe(403);
    expect(wrongTeam.json()).toMatchObject({
      status: "denied",
      reasonCode: "team_membership_missing",
    });
    expect(resources.getExecutionCount("file.read", "team-beta-internal")).toBe(0);
  });

  it("exposes team-grant enrollment and revocation only to the owner team admin", async () => {
    const { app } = await makeRuntimeApp();
    const authHeaders = { authorization: "Bearer outer-token-for-tests" };
    const actorASession = await app.inject({
      method: "POST",
      url: "/api/demo/session",
      headers: authHeaders,
      payload: { userId: "user-a" },
    });
    const actorAToken = (actorASession.json() as { sessionToken: string }).sessionToken;
    const actorAHeaders = { ...authHeaders, "x-agentgate-session": actorAToken };

    const enrolled = await app.inject({
      method: "POST",
      url: `/api/agents/${agentAId}/team-grants`,
      headers: actorAHeaders,
      payload: { teamId: "team-alpha", role: "editor" },
    });
    expect(enrolled.statusCode).toBe(201);
    expect(enrolled.json()).toMatchObject({
      grant: {
        agentId: agentAId,
        teamId: "team-alpha",
        role: "editor",
        allowedActions: ["file.read"],
        status: "active",
      },
    });
    const grantId = (enrolled.json() as { grant: { id: string } }).grant.id;

    const listed = await app.inject({
      method: "GET",
      url: `/api/agents/${agentAId}/team-grants`,
      headers: actorAHeaders,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ grants: [{ id: grantId, status: "active" }] });

    const malformed = await app.inject({
      method: "POST",
      url: `/api/agents/${agentAId}/team-grants`,
      headers: actorAHeaders,
      payload: { teamId: "team-alpha", role: "owner" },
    });
    expect(malformed.statusCode).toBe(400);

    const actorBSession = await app.inject({
      method: "POST",
      url: "/api/demo/session",
      headers: authHeaders,
      payload: { userId: "user-b" },
    });
    const actorBToken = (actorBSession.json() as { sessionToken: string }).sessionToken;
    const actorBHeaders = { ...authHeaders, "x-agentgate-session": actorBToken };
    const crossOwner = await app.inject({
      method: "GET",
      url: `/api/agents/${agentAId}/team-grants`,
      headers: actorBHeaders,
    });
    expect(crossOwner.statusCode).toBe(404);
    const nonAdmin = await app.inject({
      method: "POST",
      url: `/api/agents/${agentBId}/team-grants`,
      headers: actorBHeaders,
      payload: { teamId: "team-alpha", role: "viewer" },
    });
    expect(nonAdmin.statusCode).toBe(403);
    expect(nonAdmin.json()).toMatchObject({ code: "TEAM_ADMIN_REQUIRED" });

    const revoked = await app.inject({
      method: "POST",
      url: `/api/agents/${agentAId}/team-grants/${grantId}/revoke`,
      headers: actorAHeaders,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({
      result: { grant: { id: grantId, status: "revoked" }, runsRevoked: 0 },
    });
  });

  it("revokes an active Run and fails closed for its old runtime credential", async () => {
    const { app, runtime } = await makeRuntimeApp();
    const issued = runtime.credentials.issue(
      agentAId,
      runAId,
      "user-a",
    );
    const session = await app.inject({
      method: "POST",
      url: "/api/demo/session",
      headers: { authorization: "Bearer outer-token-for-tests" },
      payload: { userId: "user-a" },
    });
    const sessionToken = (session.json() as { sessionToken: string }).sessionToken;

    const revoked = await app.inject({
      method: "POST",
      url: `/api/agents/${agentAId}/revoke-access`,
      headers: {
        authorization: "Bearer outer-token-for-tests",
        "x-agentgate-session": sessionToken,
      },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ status: "revoked", approvalsRevoked: 0 });

    const blocked = await app.inject({
      method: "POST",
      url: "/api/runtime/actions",
      headers: runtimeHeaders(issued.token),
      payload: {
        requestId: "e315f12d-9c3c-48c2-a5d8-8c0c90d4a193",
        action: "resource.read",
        resourceId: "project-a",
      },
    });
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json()).toMatchObject({ code: "INVALID_RUNTIME_CREDENTIAL" });
  });

  it("exposes approvals and audit only through the current human owner", async () => {
    const { app, runtime } = await makeRuntimeApp();
    const agentId = agentAId;
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

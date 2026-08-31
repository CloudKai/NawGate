import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalService } from "./approval-service.js";
import { AuditService } from "./audit-service.js";
import { DeterministicPolicyEngine } from "./policy-engine.js";
import { ProtectedResourceService } from "./protected-resource-service.js";
import { RuntimeCredentialService } from "./runtime-credential-service.js";
import { RuntimeGateway } from "./runtime-gateway.js";
import { MiddlewareRunner } from "./middleware-runner.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { AgentService } from "../agent-service.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";
import { JsonStore } from "../store.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const agent = { id: AGENT_ID, ownerUserId: "user-a", name: "E2E Agent" };
const agentctl = fileURLToPath(new URL("./agentctl.mjs", import.meta.url));
const temporaryDirectories: string[] = [];
const applications: { close: () => Promise<unknown> }[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function runCli(
  args: string[],
  token: string,
  gatewayUrl: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [agentctl, ...args], {
      env: {
        PATH: process.env.PATH,
        NAWGATE_RUNTIME_TOKEN: token,
        NAWGATE_GATEWAY_URL: gatewayUrl,
        NAWGATE_APPROVAL_WAIT_MS: "3000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function createSession(baseUrl: string, userId: "user-a" | "user-b"): Promise<string> {
  const response = await fetch(baseUrl + "/api/demo/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  expect(response.status).toBe(200);
  return (await response.json() as { sessionToken: string }).sessionToken;
}

async function waitForApproval(baseUrl: string, sessionToken: string): Promise<{ id: string }> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await fetch(baseUrl + "/api/agents/" + AGENT_ID + "/approvals?status=pending", {
      headers: { "x-nawgate-session": sessionToken },
    });
    const approvals = (await response.json() as { approvals: { id: string }[] }).approvals;
    if (approvals[0]) return approvals[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the E2E approval");
}

describe("NawGate Phase 7 deterministic end-to-end flow", () => {
  it("runs agentctl over real HTTP through allow, deny, approval, consume, and replay boundaries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nawgate-phase7-e2e-"));
    temporaryDirectories.push(root);
    const store = new JsonStore(path.join(root, "db.json"));
    await store.initialize();
    const audit = new AuditService(store);
    const approvals = new ApprovalService(store, audit);
    const resources = new ProtectedResourceService(store);
    const credentials = new RuntimeCredentialService(Date.now, 10_000);
    const gateway = new RuntimeGateway(
      new DeterministicPolicyEngine(), resources, audit, approvals, store,
    );
    const service = {
      getAgent: (_id: string, actor: { id: string }) => {
        if (actor.id !== "user-a") throw new Error("Agent not found");
        return agent;
      },
      listAgents: () => [],
      systemInfo: async () => ({}),
    } as unknown as AgentService;
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        RUNTIME_PROVIDER: "container",
        CODEX_TIMEOUT_MS: "20000",
        NAWGATE_APPROVAL_WAIT_MS: "3000",
      }),
      service,
      undefined,
      { credentials, gateway, approvals, audit },
    );
    applications.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("E2E server did not bind a port");
    const baseUrl = "http://127.0.0.1:" + address.port;

    const fakeRunner: AgentRunner = {
      async run(request: RunnerRequest): Promise<RunnerResult> {
        if (request.prompt === "normal") {
          return { output: "normal coding task completed", threadId: null, usage: null };
        }
        const command = request.prompt === "allow" ? ["resource", "read", "project-a"]
          : request.prompt === "deny" ? ["resource", "read", "project-b"]
            : ["deploy", "production"];
        const result = await runCli(command, request.runtime?.token ?? "", baseUrl);
        return {
          output: result.code === 0 ? result.stdout : result.stderr,
          threadId: null,
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const runner = new MiddlewareRunner(
      fakeRunner,
      credentials,
      audit,
      loadConfig({
        NODE_ENV: "test",
        RUNTIME_PROVIDER: "container",
        CODEX_TIMEOUT_MS: "20000",
        NAWGATE_APPROVAL_WAIT_MS: "3000",
      }),
    );
    const runRequest = (prompt: string, runId: string) => runner.run({
      agentId: AGENT_ID,
      ownerUserId: "user-a",
      runId,
      workspacePath: root,
      prompt,
      threadId: null,
    });

    await expect(runRequest("normal", "00000000-0000-4000-8000-000000000010")).resolves.toBeTruthy();
    const allowed = await runRequest("allow", "00000000-0000-4000-8000-000000000011");
    expect(allowed.output).toContain("project-a");
    expect(resources.getExecutionCount("resource.read", "project-a")).toBe(1);

    const denied = await runRequest("deny", "00000000-0000-4000-8000-000000000012");
    expect(denied.output).toContain("not permitted");
    expect(resources.getExecutionCount("resource.read", "project-b")).toBe(0);
    expect(JSON.stringify(denied)).not.toContain("User B");

    const ownerSession = await createSession(baseUrl, "user-a");
    const otherSession = await createSession(baseUrl, "user-b");
    const productionRun = runRequest("production", "00000000-0000-4000-8000-000000000013");
    const approval = await waitForApproval(baseUrl, ownerSession);
    expect(resources.getDeploymentState("production", "production")?.deploymentCount).toBe(0);

    const otherApproval = await fetch(baseUrl + "/api/approvals/" + approval.id + "/approve", {
      method: "POST",
      headers: { "x-nawgate-session": otherSession },
    });
    expect(otherApproval.status).toBe(403);

    const approved = await fetch(baseUrl + "/api/approvals/" + approval.id + "/approve", {
      method: "POST",
      headers: { "x-nawgate-session": ownerSession },
    });
    expect(approved.status).toBe(200);
    await expect(productionRun).resolves.toMatchObject({ output: expect.stringContaining("owner approved once") });
    expect(resources.getDeploymentState("production", "production")?.deploymentCount).toBe(1);
    expect((await approvals.list("user-a")).find((item) => item.id === approval.id)?.status).toBe("consumed");

    const secondProduction = runRequest("production", "00000000-0000-4000-8000-000000000014");
    const secondApproval = await waitForApproval(baseUrl, ownerSession);
    expect(secondApproval.id).not.toBe(approval.id);
    expect(resources.getDeploymentState("production", "production")?.deploymentCount).toBe(1);
    await fetch(baseUrl + "/api/approvals/" + secondApproval.id + "/deny", {
      method: "POST",
      headers: { "x-nawgate-session": ownerSession },
    });
    await expect(secondProduction).resolves.toMatchObject({ output: expect.stringContaining("not permitted") });

    const evidence = JSON.stringify(store.snapshot());
    expect(evidence).not.toContain("NAWGATE_RUNTIME_TOKEN");
    expect(audit.list(AGENT_ID).map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "run.started",
      "policy.allow",
      "policy.deny",
      "policy.approval_required",
      "approval.approved",
      "capability.issued",
      "capability.consumed",
      "protected_action.succeeded",
      "run.completed",
    ]));
    expect(credentials.activeCount()).toBe(0);
  });
});

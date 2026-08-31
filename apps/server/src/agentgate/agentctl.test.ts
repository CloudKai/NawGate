import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const cliPath = new URL("./agentctl.mjs", import.meta.url).pathname;

function runCli(
  args: string[],
  mode: "success" | "denied" | "approval" | "pending",
  token = "TEST_RUNTIME_TOKEN_DO_NOT_PRINT",
  waitMs = "1000",
): Promise<{ code: number | null; stdout: string; stderr: string; received: Record<string, unknown>[] }> {
  const bootstrap = `
globalThis.__agentgateReceived = [];
let actionCount = 0;
globalThis.fetch = async (url, options = {}) => {
  const pathname = new URL(url).pathname;
  const headers = options.headers ?? {};
  const body = options.body ? JSON.parse(options.body) : null;
  globalThis.__agentgateReceived.push({ pathname, headers, body });
  if (${JSON.stringify(mode)} === "denied") {
    return new Response(JSON.stringify({ status: "denied", code: "ACTION_NOT_PERMITTED" }), { status: 403 });
  }
  if ((${JSON.stringify(mode)} === "approval" || ${JSON.stringify(mode)} === "pending") && pathname === "/api/runtime/actions" && actionCount++ === 0) {
    return new Response(JSON.stringify({ status: "approval_required", approvalId: "00000000-0000-4000-8000-000000000001", pollAfterMs: 1 }), { status: 202 });
  }
  if (${JSON.stringify(mode)} === "pending" && pathname.startsWith("/api/runtime/approvals/")) {
    return new Response(JSON.stringify({ status: "pending", approvalId: "00000000-0000-4000-8000-000000000001", pollAfterMs: 1 }), { status: 200 });
  }
  if (${JSON.stringify(mode)} === "approval" && pathname.startsWith("/api/runtime/approvals/")) {
    return new Response(JSON.stringify({ status: "approved", approvalId: "00000000-0000-4000-8000-000000000001" }), { status: 200 });
  }
  return new Response(JSON.stringify({ status: "success", result: { summary: "Deployment completed." } }), { status: 200 });
};
process.argv = ["node", "agentctl", ...JSON.parse(process.env.AGENTGATE_TEST_ARGS)];
await import(${JSON.stringify(cliPath)});
process.stdout.write("\\n__AGENTGATE_RECEIVED__" + JSON.stringify(globalThis.__agentgateReceived));
`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", bootstrap], {
      env: {
        ...process.env,
        AGENTGATE_GATEWAY_URL: "http://agentgate.test",
        AGENTGATE_RUNTIME_TOKEN: token,
        AGENTGATE_APPROVAL_WAIT_MS: waitMs,
        AGENTGATE_TEST_ARGS: JSON.stringify(args),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      const marker = "__AGENTGATE_RECEIVED__";
      const markerIndex = stdout.indexOf(marker);
      const received = markerIndex < 0
        ? []
        : JSON.parse(stdout.slice(markerIndex + marker.length)) as Record<string, unknown>[];
      resolve({
        code,
        stdout: markerIndex < 0 ? stdout : stdout.slice(0, markerIndex),
        stderr,
        received,
      });
    });
  });
}

describe("agentctl", () => {
  it("uses the narrow resource command and never sends browser auth", async () => {
    const result = await runCli(["resource", "read", "project-a"], "success");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("AgentGate: resource.read project-a -> ALLOW");
    expect(result.stdout).toContain("Deployment completed.");
    expect(result.received).toHaveLength(1);
    expect(result.received[0]).toMatchObject({
      pathname: "/api/runtime/actions",
      headers: { "X-AgentGate-Runtime": "TEST_RUNTIME_TOKEN_DO_NOT_PRINT" },
      body: { action: "resource.read", resourceId: "project-a" },
    });
    expect(result.received[0].body).toMatchObject({ requestId: expect.any(String) });
    expect(result.stderr).not.toContain("TEST_RUNTIME_TOKEN_DO_NOT_PRINT");
    expect(result.stdout).not.toContain("TEST_RUNTIME_TOKEN_DO_NOT_PRINT");
  });

  it("returns a safe non-zero denial for a rejected protected action", async () => {
    const result = await runCli(["resource", "read", "project-b"], "denied");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("The protected action was not permitted.");
    expect(result.stdout + result.stderr).not.toContain("TEST_RUNTIME_TOKEN_DO_NOT_PRINT");
  });

  it("adds only the narrow file.read command for protected team files", async () => {
    const result = await runCli(["file", "read", "team-alpha-internal"], "success");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("AgentGate: file.read team-alpha-internal -> ALLOW");
    expect(result.received).toHaveLength(1);
    expect(result.received[0]).toMatchObject({
      pathname: "/api/runtime/actions",
      body: { action: "file.read", resourceId: "team-alpha-internal" },
    });
  });

  it("sends structured synthetic content actions with no arbitrary destination", async () => {
    const result = await runCli(["content", "moderate", "asset-user-a-video-1"], "success");
    expect(result.code).toBe(0);
    expect(result.received).toHaveLength(1);
    expect(result.received[0]).toMatchObject({
      pathname: "/api/runtime/actions",
      body: {
        action: "content.moderate",
        resourceId: "asset-user-a-video-1",
        payload: {
          purpose: "safety_moderation",
          organizationId: "org-user-a",
          businessCenterId: "business-center-user-a",
          accountId: "account-user-a",
          assetId: "asset-user-a-video-1",
          contentVersion: "v1",
        },
      },
    });
    expect(result.received[0].body).not.toHaveProperty("destination");
  });

  it("uses only a registered destination ID for approved content publish", async () => {
    const result = await runCli(["content", "publish", "asset-user-a-video-1"], "approval");
    expect(result.code).toBe(0);
    const firstAction = result.received[0].body as Record<string, unknown>;
    expect(firstAction).toMatchObject({
      action: "content.publish",
      destination: "tiktok-account:brand-sg",
    });
    expect(result.stdout + result.stderr).not.toContain("SYNTHETIC_DESTINATION_SECRET_CANARY");
  });

  it("does not expose a file write/delete/share command", async () => {
    const result = await runCli(["file", "write", "team-alpha-internal"], "success");
    expect(result.code).toBe(1);
    expect(result.received).toHaveLength(0);
  });

  it("polls approval with bounded retries and reuses the request id exactly once", async () => {
    const result = await runCli(["deploy", "production"], "approval");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Waiting for owner approval...");
    expect(result.stdout).toContain("AgentGate: owner approved once -> ALLOW");
    expect(result.received).toHaveLength(3);
    const firstAction = result.received[0].body as Record<string, unknown>;
    const retry = result.received[2].body as Record<string, unknown>;
    expect(result.received[1]).toMatchObject({
      pathname: "/api/runtime/approvals/00000000-0000-4000-8000-000000000001",
    });
    expect(firstAction).toMatchObject({ action: "deploy.production", resourceId: "production" });
    expect(retry).toMatchObject({
      action: "deploy.production",
      resourceId: "production",
      approvalId: "00000000-0000-4000-8000-000000000001",
      requestId: firstAction.requestId,
    });
  });

  it("stops polling at the configured approval deadline", async () => {
    const result = await runCli(["deploy", "production"], "pending", "TEST_RUNTIME_TOKEN_DO_NOT_PRINT", "20");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Timed out waiting for owner approval.");
  });
});

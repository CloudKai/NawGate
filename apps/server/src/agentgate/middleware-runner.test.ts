import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditService } from "./audit-service.js";
import { MiddlewareRunner } from "./middleware-runner.js";
import { RuntimeCredentialService } from "./runtime-credential-service.js";
import { loadConfig } from "../config.js";
import { RunCancelledError } from "../errors.js";
import { JsonStore } from "../store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";

const temporaryDirectories: string[] = [];
const request: RunnerRequest = {
  agentId: "agent-a",
  ownerUserId: "user-a",
  runId: "run-a",
  workspacePath: "/tmp/agent-a",
  prompt: "hello",
  threadId: null,
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeMiddleware(inner: AgentRunner) {
  const root = await mkdtemp(path.join(tmpdir(), "agentgate-middleware-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const audit = new AuditService(store);
  const credentials = new RuntimeCredentialService(Date.now, 10_000);
  const config = loadConfig({
    NODE_ENV: "test",
    RUNTIME_PROVIDER: "container",
    CODEX_TIMEOUT_MS: "20000",
    AGENTGATE_GATEWAY_URL: "http://127.0.0.1:3000",
    AGENTGATE_APPROVAL_WAIT_MS: "1000",
  });
  return {
    runner: new MiddlewareRunner(inner, credentials, audit, config),
    audit,
    credentials,
  };
}

describe("MiddlewareRunner", () => {
  it("injects allowlisted runtime context and revokes it after success", async () => {
    let delegated: RunnerRequest | null = null;
    const result: RunnerResult = { output: "done", threadId: "thread-a", usage: null };
    const { runner, audit, credentials } = await makeMiddleware({
      run: async (next) => {
        delegated = next;
        expect(next.runtime?.gatewayUrl).toBe("http://127.0.0.1:3000");
        expect(next.runtime?.approvalWaitMs).toBe(1_000);
        expect(next.runtime?.token).toBeTruthy();
        expect(credentials.resolve(next.runtime?.token)).toMatchObject({
          status: "valid",
          context: { agentId: "agent-a", runId: "run-a", humanId: "user-a" },
        });
        return result;
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });

    await expect(runner.run(request)).resolves.toEqual(result);
    expect(delegated?.runtime?.token).toBeTruthy();
    expect(credentials.activeCount()).toBe(0);
    const auditJson = JSON.stringify(audit.list("agent-a"));
    expect(auditJson).toContain("run.started");
    expect(auditJson).toContain("run.completed");
    expect(auditJson).not.toContain("TEST_RUNTIME_SECRET_DO_NOT_LOG");
  });

  it("records cancellation and revokes credentials on failure", async () => {
    const { runner, audit, credentials } = await makeMiddleware({
      run: async () => {
        throw new RunCancelledError();
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });

    await expect(runner.run(request)).rejects.toBeInstanceOf(RunCancelledError);
    expect(credentials.activeCount()).toBe(0);
    expect(audit.list("agent-a").map((event) => event.eventType)).toEqual([
      "run.started",
      "run.cancelled",
    ]);
  });

  it("redacts a runtime credential echoed by the untrusted Runner", async () => {
    let echoedToken = "";
    const { runner, credentials } = await makeMiddleware({
      run: async (next) => {
        echoedToken = next.runtime?.token ?? "";
        return { output: "model saw " + echoedToken, threadId: echoedToken, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });

    const result = await runner.run(request);
    expect(echoedToken).toBeTruthy();
    expect(result.output).toBe("model saw [REDACTED_RUNTIME_CREDENTIAL]");
    expect(result.output).not.toContain(echoedToken);
    expect(result.threadId).toBe("[REDACTED_RUNTIME_CREDENTIAL]");
    expect(credentials.activeCount()).toBe(0);
  });

  it("delegates cancellation and availability to the selected runner", async () => {
    const { runner } = await makeMiddleware({
      run: async () => ({ output: "done", threadId: null, usage: null }),
      cancel: async (agentId) => agentId === "agent-a",
      isAvailable: async () => true,
    });

    await expect(runner.cancel("agent-a")).resolves.toBe(true);
    await expect(runner.isAvailable()).resolves.toBe(true);
  });
});

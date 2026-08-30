import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];
const userA = { id: "user-a", name: "User A" } as const;
const userB = { id: "user-b", name: "User B" } as const;

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" }, userA);
    expect(agent.ownerUserId).toBe("user-a");
    expect(service.listAgents(userA)).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" }, userA)).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id, userA)).status).toBe("stopped");
    expect((await service.startAgent(agent.id, userA)).status).toBe("ready");
    const store = (service as unknown as { store: JsonStore }).store;
    await store.mutate((database) => {
      database.agentTeamGrants.push({
        id: "grant-to-delete",
        agentId: agent.id,
        teamId: "team-alpha",
        role: "viewer",
        allowedActions: ["file.read"],
        status: "active",
        approvedBy: "user-a",
        expiresAt: null,
        bundleVersion: 1,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
        revokedAt: null,
      });
    });
    await service.deleteAgent(agent.id, userA);
    expect(service.listAgents(userA)).toHaveLength(0);
    expect(store.snapshot().agentTeamGrants).toEqual([
      expect.objectContaining({ id: "grant-to-delete", status: "revoked" }),
    ]);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" }, userA);
    const { run } = await service.sendMessage(agent.id, "write hello world", userA);
    await expect.poll(() => service.getRun(run.id, userA).status).toBe("completed");
    const messages = service.getMessages(agent.id, userA);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id, userA).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" }, userA);
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first", userA),
      service.sendMessage(agent.id, "second", userA),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id, userA)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id, userA).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" }, userA);
    const { run } = await service.sendMessage(agent.id, "first", userA);

    await expect(service.startAgent(agent.id, userA)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second", userA)).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id, userA).status).toBe("completed");
  });

  it("enforces ownership for every AgentService operation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Private" }, userA);
    expect(service.listAgents(userB)).toEqual([]);

    expect(() => service.getAgent(agent.id, userB)).toThrowError(/Agent not found/);
    await expect(service.updateAgent(agent.id, { name: "Forged" }, userB)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(service.startAgent(agent.id, userB)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.stopAgent(agent.id, userB)).rejects.toMatchObject({ statusCode: 404 });
    expect(() => service.getMessages(agent.id, userB)).toThrowError(/Agent not found/);
    expect(() => service.getRuns(agent.id, userB)).toThrowError(/Agent not found/);
    await expect(service.sendMessage(agent.id, "steal it", userB)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(service.deleteAgent(agent.id, userB)).rejects.toMatchObject({ statusCode: 404 });
    expect(service.getAgent(agent.id, userA).name).toBe("Private");
  });
});

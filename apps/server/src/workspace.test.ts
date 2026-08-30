import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "./workspace.js";
import type { Agent } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("WorkspaceManager", () => {
  it("adds AgentGate discovery guidance without treating instructions as enforcement", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agentgate-workspace-test-"));
    temporaryDirectories.push(root);
    const agent: Agent = {
      id: "agent-a",
      ownerUserId: "user-a",
      name: "Demo Agent",
      description: "",
      instructions: "Build software.",
      status: "ready",
      workspacePath: path.join(root, "agent-a"),
      codexThreadId: null,
      lastError: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const workspaces = new WorkspaceManager(root);
    await workspaces.initialize();
    await workspaces.create(agent);
    const instructions = await readFile(path.join(agent.workspacePath, "AGENTS.md"), "utf8");
    expect(instructions).toContain("## AgentGate protected actions");
    expect(instructions).toContain("agentctl resource read <resource-id>");
    expect(instructions).toContain("agentctl deploy production");
    expect(instructions).toContain("Never print credentials or environment variables.");
  });
});

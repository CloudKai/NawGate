import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("migrates v1 data to v3 and seeds team relationships without dropping starter records", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        agents: [
          {
            id: "agent-1",
            name: "Legacy",
            description: "",
            instructions: "",
            status: "ready",
            workspacePath: path.join(root, "workspace"),
            codexThreadId: null,
            lastError: null,
            createdAt: "2026-08-30T00:00:00.000Z",
            updatedAt: "2026-08-30T00:00:00.000Z",
          },
        ],
        messages: [],
        runs: [],
      }),
      "utf8",
    );

    const store = new JsonStore(filePath);
    await store.initialize();

    const database = store.snapshot();
    expect(database.version).toBe(3);
    expect(database.agents[0]?.ownerUserId).toBe("user-a");
    expect(database.protectedResources.map((resource) => resource.id)).toEqual([
      "project-a",
      "project-b",
      "staging",
      "production",
      "team-alpha-internal",
      "team-alpha-restricted",
      "team-beta-internal",
    ]);
    expect(database.deploymentStates.map((state) => state.resourceId)).toEqual([
      "staging",
      "production",
    ]);
    expect(database.teamMemberships).toEqual([
      { teamId: "team-alpha", humanId: "user-a", role: "admin" },
      { teamId: "team-alpha", humanId: "user-b", role: "viewer" },
      { teamId: "team-beta", humanId: "user-b", role: "editor" },
    ]);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({ version: 3 });
  });

  it("migrates an existing v2 database and adds only missing team fixtures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-v2-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    await writeFile(filePath, JSON.stringify({
      version: 2,
      agents: [],
      messages: [],
      runs: [],
      approvals: [],
      auditEvents: [],
      protectedResources: [],
      deploymentStates: [],
      actionExecutions: [],
    }), "utf8");

    const store = new JsonStore(filePath);
    await store.initialize();

    expect(store.snapshot().version).toBe(3);
    expect(store.snapshot().teamMemberships).toHaveLength(3);
    expect(store.snapshot().protectedResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "team-alpha-internal", type: "team_file" }),
      ]),
    );
  });

  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });
});

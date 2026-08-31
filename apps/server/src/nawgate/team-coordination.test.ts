import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import { AuditService } from "./audit-service.js";
import { TeamOrchestrator, type TeamAgentContext } from "./team-orchestrator.js";
import { TeamDAGRunner } from "./team-dag-runner.js";
import { AgentService } from "../agent-service.js";
import type { Agent, AgentRunner, RunnerRequest, RunnerResult, TaskGraph, TeamRun } from "../types.js";
import type { AgentTeamGrant } from "./types.js";
import { loadConfig, type AppConfig } from "../config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      try {
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Ignore locked directory cleanup errors in testing
      }
    }),
  );
});

async function createTestEnvironment(customRunner?: AgentRunner) {
  const root = await mkdtemp(path.join(tmpdir(), "team-coord-test-"));
  temporaryDirectories.push(root);

  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "mock-model",
    ARK_BASE_URL: "https://mock.ark",
  });

  const store = new JsonStore(path.join(root, "data", "db.json"));
  await store.initialize();

  const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
  const audit = new AuditService(store);

  const runner: AgentRunner = customRunner ?? {
    isAvailable: async () => true,
    cancel: async () => true,
    run: async (request: RunnerRequest): Promise<RunnerResult> => ({
      output: `Work completed by ${request.agentId}\n\`\`\`json\n{"endpoint": "/api/test"}\n\`\`\``,
      threadId: "thread-123",
      usage: null,
    }),
  };

  const dagRunner = new TeamDAGRunner(config, store, runner, audit);
  const orchestrator = new TeamOrchestrator(config);
  const service = new AgentService(config, store, workspaces, runner, undefined, audit);
  await service.initialize();

  return { root, config, store, workspaces, audit, runner, dagRunner, orchestrator, service };
}

const mockAgentA: Agent = {
  id: "agent-frontend-1",
  ownerUserId: "user-a",
  name: "Frontend Agent",
  description: "Builds React UI components",
  instructions: "Build user interfaces",
  status: "ready",
  workspacePath: "/tmp/workspaces/agent-frontend-1",
  codexThreadId: null,
  lastError: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockAgentB: Agent = {
  id: "agent-backend-2",
  ownerUserId: "user-a",
  name: "Backend Agent",
  description: "Builds API routes and server logic",
  instructions: "Build Fastify API endpoints",
  status: "ready",
  workspacePath: "/tmp/workspaces/agent-backend-2",
  codexThreadId: null,
  lastError: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockGrantA: AgentTeamGrant = {
  id: "grant-1",
  agentId: mockAgentA.id,
  teamId: "team-alpha",
  role: "editor",
  allowedActions: ["file.read", "resource.read"],
  status: "active",
  approvedBy: "user-a",
  expiresAt: null,
  bundleVersion: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  revokedAt: null,
};

const mockGrantB: AgentTeamGrant = {
  id: "grant-2",
  agentId: mockAgentB.id,
  teamId: "team-alpha",
  role: "editor",
  allowedActions: ["file.read", "resource.read"],
  status: "active",
  approvedBy: "user-a",
  expiresAt: null,
  bundleVersion: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  revokedAt: null,
};

describe("TeamOrchestrator", () => {
  it("plans a turn-by-turn sequential DAG for countdown prompts", async () => {
    const { orchestrator } = await createTestEnvironment();
    const agents: TeamAgentContext[] = [
      { agent: mockAgentA, grant: mockGrantA },
      { agent: mockAgentB, grant: mockGrantB },
    ];

    const graph = await orchestrator.planTaskGraph({
      prompt: "Count down from 10 to 1, alternating turns",
      teamId: "team-alpha",
      agents,
    });

    expect(graph.tasks.length).toBe(10);
    expect(graph.tasks[0].assignedAgentId).toBe(mockAgentA.id);
    expect(graph.tasks[1].assignedAgentId).toBe(mockAgentB.id);
    expect(graph.tasks[1].dependsOn).toEqual([graph.tasks[0].id]);
    expect(graph.tasks[9].dependsOn).toEqual([graph.tasks[8].id]);
  });

  it("plans a parallel frontend and backend DAG with barrier synchronization for fullstack requests", async () => {
    const { orchestrator } = await createTestEnvironment();
    const agents: TeamAgentContext[] = [
      { agent: mockAgentA, grant: mockGrantA },
      { agent: mockAgentB, grant: mockGrantB },
    ];

    const graph = await orchestrator.planTaskGraph({
      prompt: "Build a landing page with a login feature which redirects to hello page",
      teamId: "team-alpha",
      agents,
    });

    expect(graph.tasks.length).toBe(3);
    const backendTask = graph.tasks.find((t) => t.id.includes("backend"))!;
    const frontendTask = graph.tasks.find((t) => t.id.includes("frontend-scaffold"))!;
    const integrationTask = graph.tasks.find((t) => t.id.includes("integration"))!;

    expect(backendTask.dependsOn).toEqual([]);
    expect(frontendTask.dependsOn).toEqual([]);
    expect(integrationTask.dependsOn).toEqual([backendTask.id, frontendTask.id]);
  });
});

describe("TeamDAGRunner & Audit Integration", () => {
  it("executes parallel nodes concurrently and logs audit events", async () => {
    const executionLog: string[] = [];
    const customRunner: AgentRunner = {
      isAvailable: async () => true,
      cancel: async () => true,
      run: async (request) => {
        executionLog.push(`start:${request.agentId}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        executionLog.push(`end:${request.agentId}`);
        return {
          output: `Work completed by ${request.agentId}\n\`\`\`json\n{"endpoint": "/api/test"}\n\`\`\``,
          threadId: "thread-123",
          usage: null,
        };
      },
    };

    const { store, dagRunner } = await createTestEnvironment(customRunner);

    await store.mutate((db) => {
      db.agents.push(mockAgentA, mockAgentB);
      db.agentTeamGrants.push(mockGrantA, mockGrantB);
    });

    const testGraph: TaskGraph = {
      tasks: [
        {
          id: "task-1",
          assignedAgentId: mockAgentA.id,
          title: "Frontend Scaffolding",
          description: "Scaffold UI",
          dependsOn: [],
          status: "pending",
        },
        {
          id: "task-2",
          assignedAgentId: mockAgentB.id,
          title: "Backend Route",
          description: "Create API route",
          dependsOn: [],
          status: "pending",
        },
        {
          id: "task-3",
          assignedAgentId: mockAgentA.id,
          title: "Integration",
          description: "Wire frontend to backend",
          dependsOn: ["task-1", "task-2"],
          status: "pending",
        },
      ],
    };

    const teamRunId = "team-run-test-1";
    const initialTeamRun: TeamRun = {
      id: teamRunId,
      teamId: "team-alpha",
      ownerUserId: "user-a",
      prompt: "Build landing page and login route",
      status: "queued",
      graph: testGraph,
      blackboard: {
        state: {},
        artifacts: [],
        createdFiles: [],
      },
      startedAt: null,
      completedAt: null,
      createdAt: new Date().toISOString(),
    };

    await store.mutate((db) => {
      db.teamRuns = [initialTeamRun];
    });

    const result = await dagRunner.executeTeamRun(teamRunId, { id: "user-a", name: "User A" });

    expect(result.status).toBe("completed");
    expect(result.graph.tasks.every((t) => t.status === "completed")).toBe(true);

    // Verify task-1 and task-2 started before either finished (parallel concurrency)
    expect(executionLog.indexOf(`start:${mockAgentA.id}`)).toBeLessThan(
      executionLog.indexOf(`end:${mockAgentB.id}`),
    );

    // Verify audit events were recorded
    const auditEvents = store.snapshot().auditEvents;
    expect(auditEvents.some((e) => e.eventType === "team_run.started")).toBe(true);
    expect(auditEvents.some((e) => e.eventType === "dag_node.started")).toBe(true);
    expect(auditEvents.some((e) => e.eventType === "dag_node.completed")).toBe(true);
    expect(auditEvents.some((e) => e.eventType === "blackboard.updated")).toBe(true);
    expect(auditEvents.some((e) => e.eventType === "team_run.completed")).toBe(true);

    // Verify messages were appended with distinct agent authorNames
    const messages = store.snapshot().messages;
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(messages.some((m) => m.authorName === "Frontend Agent")).toBe(true);
    expect(messages.some((m) => m.authorName === "Backend Agent")).toBe(true);
  });
});

describe("AgentService Team Coordination Routing", () => {
  it("automatically routes to team coordination when an agent belongs to a multi-agent team", async () => {
    const { store, service } = await createTestEnvironment();

    await store.mutate((db) => {
      db.agents.push(mockAgentA, mockAgentB);
      db.agentTeamGrants.push(mockGrantA, mockGrantB);
    });

    const result = await service.sendMessage(
      mockAgentA.id,
      "Build a landing page with a login feature",
      { id: "user-a", name: "User A" },
    );

    expect(result.teamRun).toBeDefined();
    expect(result.teamRun?.teamId).toBe("team-alpha");
    expect(result.teamRun?.graph.tasks.length).toBeGreaterThanOrEqual(2);

    // Await background DAG execution completion to ensure all database mutations settle cleanly
    await expect
      .poll(() => service.getLatestTeamRun(mockAgentA.id, { id: "user-a", name: "User A" })?.status)
      .toBe("completed");

    const latestTeamRun = service.getLatestTeamRun(mockAgentA.id, { id: "user-a", name: "User A" });
    expect(latestTeamRun).not.toBeNull();
    expect(latestTeamRun?.id).toBe(result.teamRun?.id);
  });
});

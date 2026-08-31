import { randomUUID } from "node:crypto";
import { maskSensitiveData } from "./nawgate/dlp-service.js";
import type { AppConfig } from "./config.js";
import { isModelConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import type { ApprovalService } from "./nawgate/approval-service.js";
import { AuditService } from "./nawgate/audit-service.js";
import { TeamOrchestrator, type TeamAgentContext } from "./nawgate/team-orchestrator.js";
import { TeamDAGRunner } from "./nawgate/team-dag-runner.js";
import type { HumanPrincipal } from "./nawgate/types.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  TeamRun,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly orchestrator: TeamOrchestrator;
  private readonly dagRunner: TeamDAGRunner;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly approvals?: ApprovalService,
    private readonly audit?: AuditService,
  ) {
    this.orchestrator = new TeamOrchestrator(this.config);
    this.dagRunner = new TeamDAGRunner(
      this.config,
      this.store,
      this.runner,
      this.audit ?? new AuditService(this.store),
    );
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    const interruptedRunIds: string[] = [];
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          interruptedRunIds.push(run.id);
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
    for (const runId of interruptedRunIds) {
      await this.approvals?.revokeForRun(runId, "server_restarted");
    }
  }

  listAgents(actor: HumanPrincipal): Agent[] {
    return this.store
      .snapshot()
      .agents
      .filter((agent) => agent.ownerUserId === actor.id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string, actor: HumanPrincipal): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    // Ownership is checked below the HTTP layer so internal callers cannot bypass it.
    if (!agent || agent.ownerUserId !== actor.id) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput, actor: HumanPrincipal): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      ownerUserId: actor.id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(
    id: string,
    input: UpdateAgentInput,
    actor: HumanPrincipal,
  ): Promise<Agent> {
    const current = this.getAgent(id, actor);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent || agent.ownerUserId !== actor.id) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(
    id: string,
    actor: HumanPrincipal,
  ): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id, actor);
    const runIds = this.store.snapshot().runs
      .filter((run) => run.agentId === id && (run.status === "queued" || run.status === "running"))
      .map((run) => run.id);
    await this.cancelExecution(id);
    for (const runId of runIds) {
      await this.approvals?.revokeForRun(runId, "agent_deleted");
    }
    const archivedWorkspace = await this.workspaces.archive(agent);
    const deletedAt = now();
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
      for (const grant of database.agentTeamGrants) {
        if (grant.agentId === id && grant.status === "active") {
          grant.status = "revoked";
          grant.revokedAt = deletedAt;
          grant.updatedAt = deletedAt;
        }
      }
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string, actor: HumanPrincipal): Promise<Agent> {
    this.getAgent(id, actor);
    return this.setStatus(id, "ready", actor);
  }

  async stopAgent(id: string, actor: HumanPrincipal): Promise<Agent> {
    this.getAgent(id, actor);
    const activeRunId = this.getActiveRun(id, actor)?.id;
    await this.cancelExecution(id);
    if (activeRunId) await this.approvals?.revokeForRun(activeRunId, "run_cancelled");
    return this.setStatus(id, "stopped", actor);
  }

  getMessages(agentId: string, actor: HumanPrincipal): Message[] {
    this.getAgent(agentId, actor);
    const db = this.store.snapshot();
    const activeGrant = db.agentTeamGrants.find(
      (g) => g.agentId === agentId && g.status === "active",
    );
    if (activeGrant) {
      const teamGrants = db.agentTeamGrants.filter(
        (g) => g.teamId === activeGrant.teamId && g.status === "active",
      );
      if (teamGrants.length > 1) {
        const teamAgentIds = new Set(teamGrants.map((g) => g.agentId));
        return db.messages
          .filter(
            (message) =>
              message.teamId === activeGrant.teamId ||
              teamAgentIds.has(message.agentId),
          )
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      }
    }
    return db.messages
      .filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string, actor: HumanPrincipal): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    this.getAgent(run.agentId, actor);
    return run;
  }

  getRuns(agentId: string, actor: HumanPrincipal): AgentRun[] {
    this.getAgent(agentId, actor);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getActiveRun(agentId: string, actor: HumanPrincipal): AgentRun | null {
    this.getAgent(agentId, actor);
    return (
      this.store
        .snapshot()
        .runs
        .filter(
          (run) =>
            run.agentId === agentId &&
            (run.status === "queued" || run.status === "running"),
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null
    );
  }

  getTeamRun(teamRunId: string, actor: HumanPrincipal): TeamRun {
    const teamRun = this.store.snapshot().teamRuns?.find((r) => r.id === teamRunId);
    if (!teamRun || teamRun.ownerUserId !== actor.id) {
      throw new HttpError(404, "Team run not found");
    }
    return teamRun;
  }

  getLatestTeamRun(agentOrTeamId: string, actor: HumanPrincipal): TeamRun | null {
    const snapshot = this.store.snapshot();
    const runs = (snapshot.teamRuns || []).filter(
      (r) =>
        r.ownerUserId === actor.id &&
        (r.teamId === agentOrTeamId || r.graph.tasks.some((t) => t.assignedAgentId === agentOrTeamId)),
    );
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  listTeamRuns(teamId: string, actor: HumanPrincipal): TeamRun[] {
    const snapshot = this.store.snapshot();
    return (snapshot.teamRuns || [])
      .filter((r) => r.ownerUserId === actor.id && r.teamId === teamId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
    actor: HumanPrincipal,
  ): Promise<{ run: AgentRun; message: Message; teamRun?: TeamRun }> {
    this.getAgent(agentId, actor);
    if (!isModelConfigured(this.config)) {
      throw new HttpError(
        503,
        "The selected model provider is not configured. Set its API key and model, then restart.",
      );
    }
    const sanitizedPrompt = maskSensitiveData(prompt);
    const timestamp = now();

    // Check if the agent is enrolled in a team with other active members
    const dbSnapshot = this.store.snapshot();
    const activeGrant = dbSnapshot.agentTeamGrants.find(
      (g) => g.agentId === agentId && g.status === "active",
    );
    const activeTeamGrants = activeGrant
      ? dbSnapshot.agentTeamGrants.filter(
          (g) => g.teamId === activeGrant.teamId && g.status === "active",
        )
      : [];

    if (activeGrant && activeTeamGrants.length > 1) {
      return this.sendTeamMessage(activeGrant.teamId, activeTeamGrants, agentId, sanitizedPrompt, actor);
    }

    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt: sanitizedPrompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: sanitizedPrompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent || storedAgent.ownerUserId !== actor.id) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  private async sendTeamMessage(
    teamId: string,
    activeGrants: import("./nawgate/types.js").AgentTeamGrant[],
    triggerAgentId: string,
    sanitizedPrompt: string,
    actor: HumanPrincipal,
  ): Promise<{ run: AgentRun; message: Message; teamRun: TeamRun }> {
    const timestamp = now();
    const teamRunId = randomUUID();
    const dbSnapshot = this.store.snapshot();

    const teamContexts: TeamAgentContext[] = activeGrants.map((grant) => {
      const agent = dbSnapshot.agents.find((a) => a.id === grant.agentId)!;
      return { agent, grant };
    });

    // Plan DAG using TeamOrchestrator
    const graph = await this.orchestrator.planTaskGraph({
      prompt: sanitizedPrompt,
      teamId,
      agents: teamContexts,
    });

    const teamRun: TeamRun = {
      id: teamRunId,
      teamId,
      ownerUserId: actor.id,
      prompt: sanitizedPrompt,
      status: "queued",
      graph,
      blackboard: {
        state: {},
        artifacts: [],
        createdFiles: [],
      },
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };

    const run: AgentRun = {
      id: teamRunId,
      agentId: triggerAgentId,
      status: "queued",
      prompt: sanitizedPrompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };

    const message: Message = {
      id: randomUUID(),
      agentId: triggerAgentId,
      runId: teamRunId,
      role: "user",
      content: sanitizedPrompt,
      createdAt: timestamp,
      teamId,
    };

    await this.store.mutate((database) => {
      database.teamRuns = database.teamRuns ?? [];
      database.teamRuns.push(teamRun);
      database.runs.push(run);
      database.messages.push(message);

      for (const ctx of teamContexts) {
        const ag = database.agents.find((a) => a.id === ctx.agent.id);
        if (ag && ag.status !== "stopped") {
          ag.status = "busy";
          ag.updatedAt = timestamp;
        }
      }
    });

    const teamExecution = this.dagRunner.executeTeamRun(teamRunId, actor).finally(async () => {
      const finalTeamRun = this.store.snapshot().teamRuns?.find((r) => r.id === teamRunId);
      const isComplete = finalTeamRun?.status === "completed";
      const finalOutput = finalTeamRun?.graph.tasks
        .filter((t) => t.output)
        .map((t) => `**${t.title}**\n${t.output}`)
        .join("\n\n") || (isComplete ? "Team tasks completed." : "Team run encountered an issue.");

      await this.store.mutate((database) => {
        const storedRun = database.runs.find((r) => r.id === teamRunId);
        if (storedRun) {
          storedRun.status = isComplete ? "completed" : "failed";
          storedRun.output = finalOutput;
          storedRun.completedAt = now();
        }
        for (const ctx of teamContexts) {
          const ag = database.agents.find((a) => a.id === ctx.agent.id);
          if (ag && ag.status === "busy") {
            ag.status = isComplete ? "ready" : "error";
            ag.updatedAt = now();
          }
        }
      });
      for (const ctx of teamContexts) {
        this.activeExecutions.delete(ctx.agent.id);
      }
    });

    for (const ctx of teamContexts) {
      this.activeExecutions.set(ctx.agent.id, teamExecution.then(() => undefined));
    }

    return { run, message, teamRun };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      modelProvider: this.config.modelProvider,
      modelConfigured: isModelConfigured(this.config),
      modelBaseUrl: this.config.modelBaseUrl,
      modelName: this.config.modelName || null,
      // Keep these fields for existing UI clients while they migrate to the
      // provider-neutral fields above.
      arkConfigured: this.config.modelProvider === "ark" && isModelConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        ownerUserId: agentAtStart.ownerUserId,
        runId: run.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
      });
      const completedAt = now();
      const sanitizedOutput = maskSensitiveData(result.output);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = sanitizedOutput;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: sanitizedOutput,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = maskSensitiveData(rawMessage);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
    } finally {
      await this.approvals?.revokeForRun(run.id, "run_finished");
    }
  }

  private async setStatus(
    id: string,
    status: Agent["status"],
    actor: HumanPrincipal,
  ): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent || agent.ownerUserId !== actor.id) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}

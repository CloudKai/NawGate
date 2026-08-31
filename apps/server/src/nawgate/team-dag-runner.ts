import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { maskSensitiveData } from "./dlp-service.js";
import type { AppConfig } from "../config.js";
import type { JsonStore } from "../store.js";
import type {
  Agent,
  AgentRunner,
  TaskNode,
  TeamArtifact,
  TeamRun,
} from "../types.js";
import type { AuditService } from "./audit-service.js";
import { NAWGATE_POLICY_VERSION, type HumanPrincipal } from "./types.js";

const now = () => new Date().toISOString();

export class TeamDAGRunner {
  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly runner: AgentRunner,
    private readonly audit: AuditService,
  ) {}

  async executeTeamRun(teamRunId: string, actor: HumanPrincipal): Promise<TeamRun> {
    const initialSnapshot = this.store.snapshot();
    const teamRun = initialSnapshot.teamRuns?.find((r) => r.id === teamRunId);
    if (!teamRun) {
      throw new Error(`Team run ${teamRunId} not found`);
    }

    const teamId = teamRun.teamId;

    // Record team_run.started audit event
    await this.audit.record({
      eventType: "team_run.started",
      humanId: actor.id,
      agentId: null,
      runId: null,
      teamRunId,
      requestId: null,
      action: null,
      resourceId: null,
      decision: "allow",
      risk: "low",
      reasonCode: "team_dag_orchestration_started",
      approvalId: null,
      capabilityId: null,
      status: "success",
      durationMs: null,
      policyVersion: NAWGATE_POLICY_VERSION,
      explanation: `Team orchestration DAG execution started for prompt: "${teamRun.prompt.slice(0, 100)}"`,
      enforcementPoint: "TeamDAGRunner",
      protectedActionExecuted: false,
      teamId: teamId as any,
    });

    await this.store.mutate((database) => {
      const run = database.teamRuns?.find((r) => r.id === teamRunId);
      if (run) {
        run.status = "running";
        run.startedAt = now();
      }
      const storedRun = database.runs.find((r) => r.id === teamRunId);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });

    try {
      await this.runGraphLoop(teamRunId, actor);

      const finalSnapshot = this.store.snapshot();
      const finalRun = finalSnapshot.teamRuns?.find((r) => r.id === teamRunId)!;
      const allSucceeded = finalRun.graph.tasks.every((t) => t.status === "completed");

      const completedAt = now();
      await this.store.mutate((database) => {
        const run = database.teamRuns?.find((r) => r.id === teamRunId);
        if (run) {
          run.status = allSucceeded ? "completed" : "failed";
          run.completedAt = completedAt;
        }
      });

      // Record final audit event
      await this.audit.record({
        eventType: allSucceeded ? "team_run.completed" : "team_run.failed",
        humanId: actor.id,
        agentId: null,
        runId: null,
        teamRunId,
        requestId: null,
        action: null,
        resourceId: null,
        decision: allSucceeded ? "allow" : "deny",
        risk: "low",
        reasonCode: allSucceeded ? "team_dag_completed" : "team_dag_tasks_failed",
        approvalId: null,
        capabilityId: null,
        status: allSucceeded ? "success" : "failure",
        durationMs: null,
        policyVersion: NAWGATE_POLICY_VERSION,
        explanation: allSucceeded
          ? "All DAG tasks in the team run completed successfully."
          : "One or more tasks in the team run failed.",
        enforcementPoint: "TeamDAGRunner",
        protectedActionExecuted: false,
        teamId: teamId as any,
      });

      return this.store.snapshot().teamRuns?.find((r) => r.id === teamRunId)!;
    } catch (error) {
      const rawError = error instanceof Error ? error.message : String(error);
      const sanitizedError = maskSensitiveData(rawError);

      await this.store.mutate((database) => {
        const run = database.teamRuns?.find((r) => r.id === teamRunId);
        if (run) {
          run.status = "failed";
          run.completedAt = now();
        }
      });

      await this.audit.record({
        eventType: "team_run.failed",
        humanId: actor.id,
        agentId: null,
        runId: null,
        teamRunId,
        requestId: null,
        action: null,
        resourceId: null,
        decision: "deny",
        risk: "high",
        reasonCode: "team_dag_runtime_exception",
        approvalId: null,
        capabilityId: null,
        status: "failure",
        durationMs: null,
        policyVersion: NAWGATE_POLICY_VERSION,
        explanation: `Team run execution encountered an exception: ${sanitizedError}`,
        enforcementPoint: "TeamDAGRunner",
        protectedActionExecuted: false,
        teamId: teamId as any,
      });

      throw error;
    }
  }

  private async runGraphLoop(teamRunId: string, actor: HumanPrincipal): Promise<void> {
    const maxIterations = 50;
    let iteration = 0;

    while (iteration++ < maxIterations) {
      const currentRun = this.store.snapshot().teamRuns?.find((r) => r.id === teamRunId);
      if (!currentRun) break;

      const tasks = currentRun.graph.tasks;
      const completedTaskIds = new Set(
        tasks.filter((t) => t.status === "completed").map((t) => t.id),
      );
      const failedTaskIds = new Set(
        tasks.filter((t) => t.status === "failed").map((t) => t.id),
      );

      // Check if any failed prerequisite blocks pending tasks
      const readyTasks = tasks.filter((t) => {
        if (t.status !== "pending") return false;
        // If any dependency failed, mark as skipped/failed
        if (t.dependsOn.some((dep) => failedTaskIds.has(dep))) {
          return false;
        }
        return t.dependsOn.every((dep) => completedTaskIds.has(dep));
      });

      if (readyTasks.length === 0) {
        // No ready tasks left. Check if all tasks finished
        const unfinished = tasks.filter((t) => t.status === "pending" || t.status === "running");
        if (unfinished.length === 0) break;

        // If some pending tasks can never run because dependencies failed, skip them
        const unrunnable = tasks.filter(
          (t) => t.status === "pending" && t.dependsOn.some((dep) => failedTaskIds.has(dep)),
        );
        if (unrunnable.length > 0) {
          await this.store.mutate((database) => {
            const run = database.teamRuns?.find((r) => r.id === teamRunId);
            if (run) {
              for (const u of unrunnable) {
                const target = run.graph.tasks.find((t) => t.id === u.id);
                if (target) target.status = "skipped";
              }
            }
          });
          continue;
        }
        break;
      }

      // Mark ready tasks as running
      const startedAt = now();
      await this.store.mutate((database) => {
        const run = database.teamRuns?.find((r) => r.id === teamRunId);
        if (run) {
          for (const ready of readyTasks) {
            const target = run.graph.tasks.find((t) => t.id === ready.id);
            if (target) {
              target.status = "running";
              target.startedAt = startedAt;
            }
          }
        }
      });

      // Launch all ready tasks in parallel via Promise.all
      await Promise.all(
        readyTasks.map((task) => this.executeTaskNode(teamRunId, task, actor)),
      );
    }
  }

  private async executeTaskNode(
    teamRunId: string,
    task: TaskNode,
    actor: HumanPrincipal,
  ): Promise<void> {
    const startTime = Date.now();
    const dbSnapshot = this.store.snapshot();
    const agent = dbSnapshot.agents.find((a) => a.id === task.assignedAgentId);
    const teamRun = dbSnapshot.teamRuns?.find((r) => r.id === teamRunId);
    const teamId = teamRun?.teamId;

    if (!agent) {
      await this.markTaskFailed(teamRunId, task.id, `Assigned agent ${task.assignedAgentId} not found`);
      return;
    }

    // Record dag_node.started
    await this.audit.record({
      eventType: "dag_node.started",
      humanId: actor.id,
      agentId: agent.id,
      runId: null,
      teamRunId,
      taskId: task.id,
      requestId: null,
      action: null,
      resourceId: null,
      decision: "allow",
      risk: "low",
      reasonCode: "dag_task_started",
      approvalId: null,
      capabilityId: null,
      status: "success",
      durationMs: null,
      policyVersion: NAWGATE_POLICY_VERSION,
      explanation: `Task node "${task.title}" started by agent ${agent.name}`,
      enforcementPoint: "TeamDAGRunner",
      protectedActionExecuted: false,
      teamId: teamId as any,
    });

    try {
      // Build task prompt with blackboard context
      const blackboardContext = this.formatBlackboardContext(teamRun?.blackboard);
      const fullTaskPrompt = [
        `### Team Task: ${task.title}`,
        task.description,
        "",
        blackboardContext ? `### Shared Team Blackboard:\n${blackboardContext}\n` : "",
        `Respond with your work for this turn. Be concise and explain results clearly.`,
      ]
        .filter(Boolean)
        .join("\n");

      // Generate a temporary sub-run record for agent runner execution
      const subRunId = randomUUID();
      const runnerResult = await this.runner.run({
        agentId: agent.id,
        ownerUserId: actor.id,
        runId: subRunId,
        workspacePath: agent.workspacePath,
        prompt: fullTaskPrompt,
        threadId: agent.codexThreadId,
      });

      const durationMs = Date.now() - startTime;
      const sanitizedOutput = maskSensitiveData(runnerResult.output);

      // Parse output for artifacts or contracts
      const extractedArtifacts = this.extractArtifacts(task.id, agent.id, sanitizedOutput);
      const currentFiles = await this.scanWorkspaceFiles(agent.workspacePath);

      // Update blackboard & push chat message
      const completedAt = now();
      await this.store.mutate((database) => {
        const run = database.teamRuns?.find((r) => r.id === teamRunId);
        if (run) {
          const targetTask = run.graph.tasks.find((t) => t.id === task.id);
          if (targetTask) {
            targetTask.status = "completed";
            targetTask.output = sanitizedOutput;
            targetTask.completedAt = completedAt;
            targetTask.durationMs = durationMs;
          }
          if (extractedArtifacts.length > 0) {
            run.blackboard.artifacts.push(...extractedArtifacts);
          }
          const mentionedFiles = this.extractMentionedFiles(agent.name, sanitizedOutput);
          const allNewFiles = [...currentFiles.map((f) => `${agent.name}: ${f}`), ...mentionedFiles];
          if (allNewFiles.length > 0) {
            const existingFiles = new Set(run.blackboard.createdFiles || []);
            for (const f of allNewFiles) {
              existingFiles.add(f);
            }
            run.blackboard.createdFiles = Array.from(existingFiles);
          }
        }

        // Add message to chat history from this agent
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: subRunId,
          role: "assistant",
          content: sanitizedOutput,
          createdAt: completedAt,
          authorName: agent.name,
          teamId: teamId ?? null,
        });

        // Update agent thread
        const storedAgent = database.agents.find((a) => a.id === agent.id);
        if (storedAgent) {
          storedAgent.codexThreadId = runnerResult.threadId;
          storedAgent.updatedAt = completedAt;
        }
      });

      // Record dag_node.completed
      await this.audit.record({
        eventType: "dag_node.completed",
        humanId: actor.id,
        agentId: agent.id,
        runId: subRunId,
        teamRunId,
        taskId: task.id,
        requestId: null,
        action: null,
        resourceId: null,
        decision: "allow",
        risk: "low",
        reasonCode: "dag_task_completed",
        approvalId: null,
        capabilityId: null,
        status: "success",
        durationMs,
        policyVersion: NAWGATE_POLICY_VERSION,
        explanation: `Task node "${task.title}" completed successfully in ${durationMs}ms`,
        enforcementPoint: "TeamDAGRunner",
        protectedActionExecuted: false,
        teamId: teamId as any,
      });

      if (extractedArtifacts.length > 0) {
        await this.audit.record({
          eventType: "blackboard.updated",
          humanId: actor.id,
          agentId: agent.id,
          runId: subRunId,
          teamRunId,
          taskId: task.id,
          requestId: null,
          action: null,
          resourceId: null,
          decision: "allow",
          risk: "low",
          reasonCode: "blackboard_artifacts_published",
          approvalId: null,
          capabilityId: null,
          status: "success",
          durationMs: null,
          policyVersion: NAWGATE_POLICY_VERSION,
          explanation: `Agent ${agent.name} published ${extractedArtifacts.length} artifact(s) to the shared blackboard.`,
          enforcementPoint: "TeamDAGRunner",
          protectedActionExecuted: false,
          teamId: teamId as any,
        });
      }
    } catch (error) {
      const rawError = error instanceof Error ? error.message : String(error);
      const sanitizedError = maskSensitiveData(rawError);
      await this.markTaskFailed(teamRunId, task.id, sanitizedError);

      await this.audit.record({
        eventType: "dag_node.completed",
        humanId: actor.id,
        agentId: agent.id,
        runId: null,
        teamRunId,
        taskId: task.id,
        requestId: null,
        action: null,
        resourceId: null,
        decision: "deny",
        risk: "high",
        reasonCode: "dag_task_failed",
        approvalId: null,
        capabilityId: null,
        status: "failure",
        durationMs: Date.now() - startTime,
        policyVersion: NAWGATE_POLICY_VERSION,
        explanation: `Task node "${task.title}" failed: ${sanitizedError}`,
        enforcementPoint: "TeamDAGRunner",
        protectedActionExecuted: false,
        teamId: teamId as any,
      });
    }
  }

  private async markTaskFailed(teamRunId: string, taskId: string, error: string): Promise<void> {
    const completedAt = now();
    await this.store.mutate((database) => {
      const run = database.teamRuns?.find((r) => r.id === teamRunId);
      if (run) {
        const target = run.graph.tasks.find((t) => t.id === taskId);
        if (target) {
          target.status = "failed";
          target.error = error;
          target.completedAt = completedAt;
        }
      }
    });
  }

  private formatBlackboardContext(blackboard?: TeamRun["blackboard"]): string {
    if (!blackboard) return "";
    const sections: string[] = [];

    if (blackboard.artifacts && blackboard.artifacts.length > 0) {
      sections.push(
        "#### Published Artifacts & Contracts:\n" +
          blackboard.artifacts
            .map((a) => `- [${a.type}] ${a.name}:\n\`\`\`\n${a.content}\n\`\`\``)
            .join("\n"),
      );
    }

    if (blackboard.createdFiles && blackboard.createdFiles.length > 0) {
      sections.push("#### Files Created:\n" + blackboard.createdFiles.map((f) => `- ${f}`).join("\n"));
    }

    return sections.join("\n\n");
  }

  private extractArtifacts(taskId: string, agentId: string, output: string): TeamArtifact[] {
    const artifacts: TeamArtifact[] = [];

    // 1. Extract fenced code blocks
    const codeBlockRegex = /```([a-zA-Z0-9_-]*)\s*([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    let index = 1;

    while ((match = codeBlockRegex.exec(output)) !== null) {
      const lang = (match[1] ?? "").trim();
      const snippet = (match[2] ?? "").trim();
      if (snippet) {
        const isContract =
          snippet.includes("/api/") ||
          snippet.includes("endpoint") ||
          snippet.includes("interface") ||
          snippet.includes("POST") ||
          snippet.includes("GET") ||
          lang === "json" ||
          lang === "openapi";

        artifacts.push({
          id: randomUUID(),
          agentId,
          taskId,
          type: isContract ? "contract" : "schema",
          name: isContract ? `API-Contract-${index++}` : `Artifact-${index++}`,
          content: snippet.slice(0, 1500),
          createdAt: now(),
        });
      }
    }

    // 2. If no fenced blocks, check for structured file specifications or endpoint declarations
    if (
      artifacts.length === 0 &&
      (output.includes(".html") ||
        output.includes(".js") ||
        output.includes("/login") ||
        output.includes("/api/"))
    ) {
      const bulletLines = output
        .split("\n")
        .filter((line) => line.trim().startsWith("-") || line.trim().startsWith("*"))
        .map((l) => l.trim().replace(/^[-*]\s*/, ""))
        .filter((l) => l.length > 5);

      if (bulletLines.length > 0) {
        artifacts.push({
          id: randomUUID(),
          agentId,
          taskId,
          type: "contract",
          name: `Feature-Specs-${index++}`,
          content: bulletLines.join("\n"),
          createdAt: now(),
        });
      }
    }

    return artifacts;
  }

  private extractMentionedFiles(agentName: string, output: string): string[] {
    const files: string[] = [];
    const fileRegex = /`?([a-zA-Z0-9_\-./]+\.(?:html|js|jsx|ts|tsx|css|json|py|sh|sql))`?(?::\d+)?/gi;
    let match: RegExpExecArray | null;
    while ((match = fileRegex.exec(output)) !== null) {
      const filename = match[1];
      if (
        filename &&
        !filename.includes("README.md") &&
        !filename.includes("AGENTS.md") &&
        !filename.startsWith(".")
      ) {
        files.push(`${agentName}: ${filename}`);
      }
    }
    return Array.from(new Set(files));
  }

  private async scanWorkspaceFiles(workspacePath: string): Promise<string[]> {
    try {
      const entries = await readdir(workspacePath, { recursive: true });
      return entries
        .filter(
          (entry) =>
            typeof entry === "string" &&
            !entry.startsWith(".") &&
            !entry.includes(".git") &&
            !entry.includes(".codex") &&
            entry !== "README.md" &&
            entry !== "AGENTS.md" &&
            entry !== ".gitignore",
        )
        .sort();
    } catch {
      return [];
    }
  }
}

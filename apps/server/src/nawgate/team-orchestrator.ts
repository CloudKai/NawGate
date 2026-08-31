import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { isModelConfigured } from "../config.js";
import type { Agent, TaskGraph, TaskNode } from "../types.js";
import type { AgentTeamGrant } from "./types.js";

export interface TeamAgentContext {
  agent: Agent;
  grant: AgentTeamGrant;
}

export interface OrchestrationInput {
  prompt: string;
  teamId: string;
  agents: TeamAgentContext[];
}

export class TeamOrchestrator {
  constructor(private readonly config: AppConfig) {}

  async planTaskGraph(input: OrchestrationInput): Promise<TaskGraph> {
    const { prompt, agents } = input;
    if (agents.length === 0) {
      throw new Error("Cannot orchestrate for a team with no active agents");
    }

    // If only one agent is in the team, return a single-node graph
    if (agents.length === 1) {
      const soleAgent = agents[0]!.agent;
      return {
        tasks: [
          {
            id: "task-1",
            assignedAgentId: soleAgent.id,
            title: `Execute task with ${soleAgent.name}`,
            description: prompt,
            dependsOn: [],
            status: "pending",
          },
        ],
      };
    }

    // Try generating plan via configured model provider if available
    if (isModelConfigured(this.config)) {
      try {
        const llmGraph = await this.planWithLLM(input);
        if (llmGraph && this.isValidGraph(llmGraph, agents)) {
          return llmGraph;
        }
      } catch {
        // Fall back to heuristic planner if LLM request fails or is unreachable
      }
    }

    // Fallback: Smart heuristic DAG generator based on agent roles and prompt analysis
    return this.planWithHeuristics(input);
  }

  private async planWithLLM(input: OrchestrationInput): Promise<TaskGraph | null> {
    const { prompt, agents } = input;
    const agentProfiles = agents.map(({ agent, grant }) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      instructions: agent.instructions,
      role: grant.role,
      allowedActions: grant.allowedActions,
    }));

    const systemPrompt = `You are a Team Task Orchestrator. You decompose a user request into a Directed Acyclic Graph (DAG) of sub-tasks for a multi-agent team.
Available Agents:
${JSON.stringify(agentProfiles, null, 2)}

Rules:
1. Decompose the request into logical sub-tasks.
2. If tasks can be done in parallel (independent tasks), set dependsOn to [] or only the common prerequisites.
3. If a task requires output/contracts from an earlier task, set dependsOn to the required task IDs.
4. Output MUST be valid JSON only matching:
{
  "tasks": [
    {
      "id": "task-1",
      "assignedAgentId": "<valid agent id>",
      "title": "<short title>",
      "description": "<detailed instruction for this agent>",
      "dependsOn": []
    }
  ]
}`;

    const url =
      this.config.modelProvider === "ark"
        ? `${this.config.arkBaseUrl}/chat/completions`
        : `${this.config.modelBaseUrl}/chat/completions`;

    const model =
      this.config.modelProvider === "ark"
        ? this.config.arkModel
        : this.config.modelName;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.modelApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `User Goal: "${prompt}"` },
        ],
        temperature: 0.2,
      }),
    });

    if (!response.ok) return null;
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawContent = data.choices?.[0]?.message?.content?.trim();
    if (!rawContent) return null;

    // Extract JSON block
    const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as { tasks?: TaskNode[] };
    if (!Array.isArray(parsed.tasks)) return null;

    const tasks: TaskNode[] = parsed.tasks.map((task, index) => ({
      id: task.id || `task-${index + 1}`,
      assignedAgentId: task.assignedAgentId,
      title: task.title || `Subtask ${index + 1}`,
      description: task.description || prompt,
      dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : [],
      status: "pending" as const,
    }));

    return { tasks };
  }

  private planWithHeuristics(input: OrchestrationInput): TaskGraph {
    const { prompt, agents } = input;
    const lowerPrompt = prompt.toLowerCase();

    // Check for countdown / turn-taking prompt pattern
    const isCountdown =
      lowerPrompt.includes("count down") ||
      lowerPrompt.includes("countdown") ||
      (lowerPrompt.includes("count") && (lowerPrompt.includes("10") || lowerPrompt.includes("1")));

    if (isCountdown && agents.length >= 2) {
      // Find start and end numbers (e.g. 10 to 1)
      const countMatch = lowerPrompt.match(/(\d+)\s*(?:to|down to)\s*(\d+)/i) || ["", "10", "1"];
      const start = parseInt(countMatch[1] || "10", 10);
      const end = parseInt(countMatch[2] || "1", 10);

      const tasks: TaskNode[] = [];
      let currentAgentIdx = 0;
      let prevTaskId: string | null = null;

      for (let num = start; num >= end; num--) {
        const taskId = `count-${num}`;
        const assignedAgent = agents[currentAgentIdx]!.agent;
        tasks.push({
          id: taskId,
          assignedAgentId: assignedAgent.id,
          title: `${assignedAgent.name}: Count ${num}`,
          description: `You are taking your turn in the team countdown. The current number to output is ${num}. Output the number "${num}" and a brief polite remark.`,
          dependsOn: prevTaskId ? [prevTaskId] : [],
          status: "pending",
        });
        prevTaskId = taskId;
        currentAgentIdx = (currentAgentIdx + 1) % agents.length;
      }
      return { tasks };
    }

    // Check for Full-Stack / Landing Page + Backend patterns
    const isFullStack =
      (lowerPrompt.includes("landing page") || lowerPrompt.includes("frontend") || lowerPrompt.includes("ui") || lowerPrompt.includes("page")) &&
      (lowerPrompt.includes("backend") || lowerPrompt.includes("login") || lowerPrompt.includes("api") || lowerPrompt.includes("server"));

    const frontendAgent =
      agents.find((a) =>
        a.agent.name.toLowerCase().includes("front") ||
        a.agent.description.toLowerCase().includes("front") ||
        a.agent.description.toLowerCase().includes("ui") ||
        a.agent.description.toLowerCase().includes("react"),
      ) || agents[0]!;

    const backendAgent =
      agents.find(
        (a) =>
          a.agent.id !== frontendAgent.agent.id &&
          (a.agent.name.toLowerCase().includes("back") ||
            a.agent.description.toLowerCase().includes("back") ||
            a.agent.description.toLowerCase().includes("api") ||
            a.agent.description.toLowerCase().includes("server")),
      ) || agents.find((a) => a.agent.id !== frontendAgent.agent.id) || agents[0]!;

    if (isFullStack && frontendAgent.agent.id !== backendAgent.agent.id) {
      return {
        tasks: [
          {
            id: "task-1-backend",
            assignedAgentId: backendAgent.agent.id,
            title: `${backendAgent.agent.name}: Implement Backend API & Schema`,
            description: `Analyze the user goal: "${prompt}". Implement the required backend routes/endpoints (e.g. /api/login) and publish the API contract with payload format.`,
            dependsOn: [],
            status: "pending",
          },
          {
            id: "task-2-frontend-scaffold",
            assignedAgentId: frontendAgent.agent.id,
            title: `${frontendAgent.agent.name}: Scaffold UI Components`,
            description: `Analyze the user goal: "${prompt}". Scaffold the landing page UI layout and destination page structure in the frontend.`,
            dependsOn: [],
            status: "pending",
          },
          {
            id: "task-3-integration",
            assignedAgentId: frontendAgent.agent.id,
            title: `${frontendAgent.agent.name}: Connect UI to Backend API`,
            description: `Consume the backend API contract from task-1-backend and wire up the UI form submission and redirection to complete the feature.`,
            dependsOn: ["task-1-backend", "task-2-frontend-scaffold"],
            status: "pending",
          },
        ],
      };
    }

    // Default Multi-Agent Parallel + Review Pipeline
    const tasks: TaskNode[] = [];
    const parallelAgents = agents.slice(0, Math.min(agents.length, 3));

    parallelAgents.forEach((a, idx) => {
      tasks.push({
        id: `task-${idx + 1}`,
        assignedAgentId: a.agent.id,
        title: `${a.agent.name}: Subtask Execution`,
        description: `Work on your domain slice for the user request: "${prompt}".`,
        dependsOn: [],
        status: "pending",
      });
    });

    if (agents.length > 1) {
      const reviewer = agents[agents.length - 1]!.agent;
      tasks.push({
        id: `task-${parallelAgents.length + 1}-review`,
        assignedAgentId: reviewer.id,
        title: `${reviewer.name}: Verification & Synthesis`,
        description: `Review results from previous tasks and provide a final synthesized completion report.`,
        dependsOn: parallelAgents.map((_, i) => `task-${i + 1}`),
        status: "pending",
      });
    }

    return { tasks };
  }

  private isValidGraph(graph: TaskGraph, agents: TeamAgentContext[]): boolean {
    if (!graph.tasks || graph.tasks.length === 0) return false;
    const validAgentIds = new Set(agents.map((a) => a.agent.id));
    const taskIds = new Set<string>();

    for (const task of graph.tasks) {
      if (!task.id || taskIds.has(task.id)) return false;
      if (!validAgentIds.has(task.assignedAgentId)) return false;
      taskIds.add(task.id);
    }

    for (const task of graph.tasks) {
      for (const dep of task.dependsOn) {
        if (!taskIds.has(dep) || dep === task.id) return false;
      }
    }

    // Check for cycles
    return !this.hasCycle(graph.tasks);
  }

  private hasCycle(tasks: TaskNode[]): boolean {
    const adj = new Map<string, string[]>();
    for (const t of tasks) adj.set(t.id, [...t.dependsOn]);

    const visited = new Set<string>();
    const recStack = new Set<string>();

    const dfs = (node: string): boolean => {
      visited.add(node);
      recStack.add(node);

      for (const neighbor of adj.get(node) || []) {
        if (!visited.has(neighbor)) {
          if (dfs(neighbor)) return true;
        } else if (recStack.has(neighbor)) {
          return true;
        }
      }

      recStack.delete(node);
      return false;
    };

    for (const task of tasks) {
      if (!visited.has(task.id)) {
        if (dfs(task.id)) return true;
      }
    }
    return false;
  }
}

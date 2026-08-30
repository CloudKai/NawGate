import type {
  AgentGateAction,
  ActionExecutionRecord,
  ProtectedActionResult,
  ProtectedResource,
} from "./types.js";
import { JsonStore } from "../store.js";

const projectProfiles = new Map<string, string>([
  ["project-a", "Synthetic profile for project-a: owner User A."],
  ["project-b", "Synthetic profile for project-b: owner User B."],
]);

export class ProtectedResourceError extends Error {}

interface ExecutionContext {
  runId: string;
  requestId: string;
}

export class ProtectedResourceService {
  private readonly executions = new Map<string, number>();

  constructor(private readonly store: JsonStore) {}

  getMetadata(resourceId: string): ProtectedResource | null {
    const resource = this.store
      .snapshot()
      .protectedResources.find((candidate) => candidate.id === resourceId);
    return resource ? structuredClone(resource) : null;
  }

  async execute(
    action: AgentGateAction,
    resourceId: string,
    execution?: ExecutionContext,
  ): Promise<ProtectedActionResult> {
    const resource = this.getMetadata(resourceId);
    if (!resource) {
      throw new ProtectedResourceError("Protected resource not found");
    }

    if (action === "resource.read") {
      if (resource.type !== "project_profile") {
        throw new ProtectedResourceError("Protected resource does not support reads");
      }
      const content = projectProfiles.get(resourceId);
      if (!content) {
        throw new ProtectedResourceError("Protected resource content not found");
      }
      await this.persistExecution(execution, action, resourceId, {
        summary: "Read protected project profile " + resourceId,
      });
      this.recordExecution(action, resourceId);
      return { summary: "Read protected project profile " + resourceId, content };
    }

    if (resource.type !== "deployment_target") {
      throw new ProtectedResourceError("Protected resource does not support deployment");
    }
    const environment = action === "deploy.staging" ? "staging" : "production";
    const deployedVersion = "demo-" + Date.now();
    await this.store.mutate((database) => {
      const state = database.deploymentStates.find(
        (candidate) =>
          candidate.resourceId === resourceId && candidate.environment === environment,
      );
      if (!state) {
        throw new ProtectedResourceError("Deployment state not found");
      }
      state.deployedVersion = deployedVersion;
      state.deploymentCount += 1;
      state.updatedAt = new Date().toISOString();
      if (execution) {
        database.actionExecutions.push({
          runId: execution.runId,
          requestId: execution.requestId,
          action,
          resourceId,
          status: "succeeded",
          resultSummary: { summary: "Deployed to " + environment },
          completedAt: new Date().toISOString(),
        });
      }
    });
    this.recordExecution(action, resourceId);
    return {
      summary: "Deployed to " + environment,
    };
  }

  getExecutionCount(action: AgentGateAction, resourceId: string): number {
    return this.executions.get(this.executionKey(action, resourceId)) ?? 0;
  }

  getDeploymentState(resourceId: string, environment: "staging" | "production") {
    return this.store
      .snapshot()
      .deploymentStates.find(
        (state) => state.resourceId === resourceId && state.environment === environment,
      );
  }

  private recordExecution(action: AgentGateAction, resourceId: string): void {
    const key = this.executionKey(action, resourceId);
    this.executions.set(key, (this.executions.get(key) ?? 0) + 1);
  }

  private async persistExecution(
    execution: ExecutionContext | undefined,
    action: AgentGateAction,
    resourceId: string,
    resultSummary: ActionExecutionRecord["resultSummary"],
  ): Promise<void> {
    if (!execution) return;
    await this.store.mutate((database) => {
      database.actionExecutions.push({
        runId: execution.runId,
        requestId: execution.requestId,
        action,
        resourceId,
        status: "succeeded",
        resultSummary,
        completedAt: new Date().toISOString(),
      });
    });
  }

  private executionKey(action: AgentGateAction, resourceId: string): string {
    return action + ":" + resourceId;
  }
}

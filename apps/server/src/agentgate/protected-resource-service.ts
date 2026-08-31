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

// Protected file payloads are intentionally server-only. Only the result of
// a RuntimeGateway-authorized read can cross the resource boundary.
const teamFiles = new Map<string, string>([
  ["team-alpha-internal", "Synthetic internal Team Alpha file."],
  ["team-alpha-restricted", "Synthetic restricted Team Alpha file."],
  ["team-beta-internal", "Synthetic internal Team Beta file."],
]);

// Synthetic TikTok-oriented content is kept behind this service boundary.
// It is never copied into Agent workspaces or audit records.
const contentAssets = new Map<string, {
  content: string;
  moderationSummary: string;
}>([
  ["asset-user-a-video-1", {
    content: "Synthetic User A short-form video payload.",
    moderationSummary: "safe=true; findings=0; aggregate-only",
  }],
  ["asset-user-a-video-2", {
    content: "Synthetic User A second short-form video payload.",
    moderationSummary: "safe=true; findings=1; aggregate-only",
  }],
  ["asset-user-b-video-1", {
    content: "Synthetic User B short-form video payload.",
    moderationSummary: "safe=false; findings=2; aggregate-only",
  }],
]);

export class ProtectedResourceError extends Error {}

export interface ResourceClaimInvalidator {
  revokeForResource(resourceId: string, reasonCode?: string): Promise<unknown>;
}

interface ExecutionContext {
  runId: string;
  requestId: string;
  payloadDigest: string;
  destination: string | null;
  policyRevision: string;
  resourceRevision: number;
}

export class ProtectedResourceService {
  private readonly executions = new Map<string, number>();

  constructor(
    private readonly store: JsonStore,
    private readonly claims?: ResourceClaimInvalidator,
  ) {}

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
    if (execution && resource.revision !== execution.resourceRevision) {
      throw new ProtectedResourceError("Protected resource revision changed");
    }

    if (action.startsWith("content.")) {
      if (resource.type !== "content_asset") {
        throw new ProtectedResourceError("Protected resource does not support content actions");
      }
      const asset = contentAssets.get(resource.assetId);
      if (!asset) throw new ProtectedResourceError("Protected content not found");
      const expectedResourceRevision = execution?.resourceRevision ?? resource.revision;
      if (action === "content.moderate") {
        await this.persistExecution(execution, action, resourceId, expectedResourceRevision, {
          summary: "Content moderation aggregate for " + resource.assetId,
        });
        this.recordExecution(action, resourceId);
        return {
          summary: "Content moderation aggregate for " + resource.assetId + ": " + asset.moderationSummary,
        };
      }
      if (action === "content.disclose") {
        await this.persistExecution(execution, action, resourceId, expectedResourceRevision, {
          summary: "Disclosed approved content for " + resource.assetId,
        });
        this.recordExecution(action, resourceId);
        return {
          summary: "Disclosed approved content for " + resource.assetId,
          content: asset.content,
        };
      }
      const summary = action === "content.publish"
        ? "Published content for " + resource.assetId
        : "Exported content for " + resource.assetId;
      await this.persistExecution(execution, action, resourceId, expectedResourceRevision, { summary });
      this.recordExecution(action, resourceId);
      return { summary };
    }

    if (action === "resource.read") {
      if (resource.type !== "project_profile") {
        throw new ProtectedResourceError("Protected resource does not support reads");
      }
      const content = projectProfiles.get(resourceId);
      if (!content) {
        throw new ProtectedResourceError("Protected resource content not found");
      }
      await this.persistExecution(execution, action, resourceId, undefined, {
        summary: "Read protected project profile " + resourceId,
      });
      this.recordExecution(action, resourceId);
      return { summary: "Read protected project profile " + resourceId, content };
    }

    if (action === "file.read") {
      if (resource.type !== "team_file") {
        throw new ProtectedResourceError("Protected resource does not support file reads");
      }
      const content = teamFiles.get(resourceId);
      if (!content) {
        throw new ProtectedResourceError("Protected file content not found");
      }
      await this.persistExecution(execution, action, resourceId, undefined, {
        summary: "Read protected team file " + resourceId,
      });
      this.recordExecution(action, resourceId);
      return { summary: "Read protected team file " + resourceId, content };
    }

    if (resource.type !== "deployment_target") {
      throw new ProtectedResourceError("Protected resource does not support deployment");
    }
    const environment = action === "deploy.staging" ? "staging" : "production";
    const deployedVersion = "demo-" + Date.now();
    const expectedResourceRevision = execution?.resourceRevision ?? resource.revision;
    await this.store.mutate((database) => {
      // The initial metadata check above is intentionally not sufficient:
      // another serialized mutation can bump the resource after that read
      // and before this callback runs. Verify the expected revision inside
      // the same transaction that mutates deployment state.
      const currentResource = database.protectedResources.find(
        (candidate) => candidate.id === resourceId,
      );
      if (!currentResource || currentResource.revision !== expectedResourceRevision) {
        throw new ProtectedResourceError("Protected resource revision changed");
      }
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
          payloadDigest: execution.payloadDigest,
          destination: execution.destination,
          policyRevision: execution.policyRevision,
          resourceRevision: execution.resourceRevision,
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

  /**
   * Resource revision changes are an explicit revocation boundary for
   * outstanding approval claims. The resource remains registered so callers
   * can observe and authorize its new revision.
   */
  async bumpRevision(
    resourceId: string,
    reasonCode = "resource_revision_changed",
  ): Promise<ProtectedResource> {
    const resource = await this.store.mutate((database) => {
      const current = database.protectedResources.find((candidate) => candidate.id === resourceId);
      if (!current) throw new ProtectedResourceError("Protected resource not found");
      current.revision += 1;
      return structuredClone(current);
    });
    await this.claims?.revokeForResource(resourceId, reasonCode);
    return resource;
  }

  async revoke(
    resourceId: string,
    reasonCode = "resource_revoked",
  ): Promise<ProtectedResource> {
    return this.bumpRevision(resourceId, reasonCode);
  }

  private recordExecution(action: AgentGateAction, resourceId: string): void {
    const key = this.executionKey(action, resourceId);
    this.executions.set(key, (this.executions.get(key) ?? 0) + 1);
  }

  private async persistExecution(
    execution: ExecutionContext | undefined,
    action: AgentGateAction,
    resourceId: string,
    expectedResourceRevision: number | undefined,
    resultSummary: ActionExecutionRecord["resultSummary"],
  ): Promise<void> {
    if (!execution && expectedResourceRevision === undefined) return;
    await this.store.mutate((database) => {
      if (expectedResourceRevision !== undefined) {
        const currentResource = database.protectedResources.find(
          (candidate) => candidate.id === resourceId,
        );
        if (!currentResource || currentResource.revision !== expectedResourceRevision) {
          throw new ProtectedResourceError("Protected resource revision changed");
        }
      }
      if (!execution) return;
      database.actionExecutions.push({
          runId: execution.runId,
          requestId: execution.requestId,
          payloadDigest: execution.payloadDigest,
          destination: execution.destination,
          policyRevision: execution.policyRevision,
          resourceRevision: execution.resourceRevision,
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

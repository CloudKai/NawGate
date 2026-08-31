import type {
  NawGateAction,
  ActionExecutionRecord,
  ApprovalAuthorityRole,
  ApprovalDecision,
  ContentAction,
  ContentPurpose,
  ProtectedActionResult,
  ProtectedResource,
  HumanId,
  RiskTier,
} from "./types.js";
import { JsonStore } from "../store.js";
import type { Database } from "../types.js";
import type { ContentDestinationExecutor } from "./local-destination-adapter.js";
import type { RegisteredDestinationId } from "./types.js";

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
  destinationRevision: number | null;
  contentPurpose: ContentPurpose | null;
  finalRecheck?: (database: Database) => void | Promise<void>;
  requesterHumanId?: HumanId;
  organizationId?: string;
  accountId?: string | null;
  risk?: RiskTier;
  riskVersion?: string;
  riskFactsDigest?: string;
  requiredApprovalCount?: number | null;
  requiredApprovalRoles?: ApprovalAuthorityRole[] | null;
  approvalDecisions?: ApprovalDecision[] | null;
}

export class ProtectedResourceService {
  private readonly executions = new Map<string, number>();

  constructor(
    private readonly store: JsonStore,
    private readonly claims?: ResourceClaimInvalidator,
    private readonly destinations?: ContentDestinationExecutor,
  ) {}

  getMetadata(resourceId: string): ProtectedResource | null {
    const resource = this.store
      .snapshot()
      .protectedResources.find((candidate) => candidate.id === resourceId);
    return resource ? structuredClone(resource) : null;
  }

  async execute(
    action: NawGateAction,
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
      if (
        !execution ||
        !execution.destination ||
        execution.destinationRevision === null ||
        !execution.contentPurpose ||
        !this.destinations
      ) {
        throw new ProtectedResourceError("Content destination execution context is incomplete");
      }
      const summary = action === "content.publish"
        ? "Published content for " + resource.assetId
        : action === "content.export"
          ? "Exported content for " + resource.assetId
          : "Disclosed approved content for " + resource.assetId;
      await this.destinations.execute({
        action: action as ContentAction,
        resource,
        purpose: execution.contentPurpose,
        destinationId: execution.destination as RegisteredDestinationId,
        destinationRevision: execution.destinationRevision,
        resourceRevision: expectedResourceRevision,
        execution: {
          runId: execution.runId,
          requestId: execution.requestId,
          payloadDigest: execution.payloadDigest,
          destination: execution.destination,
          policyRevision: execution.policyRevision,
          ...(execution.finalRecheck ? { finalRecheck: execution.finalRecheck } : {}),
          ...(execution.requesterHumanId ? { requesterHumanId: execution.requesterHumanId } : {}),
          ...(execution.organizationId ? { organizationId: execution.organizationId } : {}),
          ...(execution.accountId !== undefined ? { accountId: execution.accountId } : {}),
          ...(execution.risk ? { risk: execution.risk } : {}),
          ...(execution.riskVersion ? { riskVersion: execution.riskVersion } : {}),
          ...(execution.riskFactsDigest ? { riskFactsDigest: execution.riskFactsDigest } : {}),
          ...(execution.requiredApprovalCount !== undefined ? { requiredApprovalCount: execution.requiredApprovalCount } : {}),
          ...(execution.requiredApprovalRoles !== undefined ? { requiredApprovalRoles: execution.requiredApprovalRoles } : {}),
          ...(execution.approvalDecisions !== undefined ? { approvalDecisions: execution.approvalDecisions } : {}),
        },
      });
      this.recordExecution(action, resourceId);
      return action === "content.disclose"
        ? { summary, content: asset.content }
        : { summary };
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
    await this.store.mutate(async (database) => {
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
      await execution?.finalRecheck?.(database);
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
          destinationRevision: execution.destinationRevision,
          requesterHumanId: execution.requesterHumanId ?? null,
          organizationId: execution.organizationId ?? null,
          accountId: execution.accountId ?? null,
          risk: execution.risk ?? null,
          riskVersion: execution.riskVersion ?? null,
          riskFactsDigest: execution.riskFactsDigest ?? null,
          requiredApprovalCount: execution.requiredApprovalCount ?? null,
          requiredApprovalRoles: execution.requiredApprovalRoles ?? null,
          approvalDecisions: execution.approvalDecisions ?? null,
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

  getExecutionCount(action: NawGateAction, resourceId: string): number {
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

  private recordExecution(action: NawGateAction, resourceId: string): void {
    const key = this.executionKey(action, resourceId);
    this.executions.set(key, (this.executions.get(key) ?? 0) + 1);
  }

  private async persistExecution(
    execution: ExecutionContext | undefined,
    action: NawGateAction,
    resourceId: string,
    expectedResourceRevision: number | undefined,
    resultSummary: ActionExecutionRecord["resultSummary"],
  ): Promise<void> {
    if (!execution && expectedResourceRevision === undefined) return;
    await this.store.mutate(async (database) => {
      if (expectedResourceRevision !== undefined) {
        const currentResource = database.protectedResources.find(
          (candidate) => candidate.id === resourceId,
        );
        if (!currentResource || currentResource.revision !== expectedResourceRevision) {
          throw new ProtectedResourceError("Protected resource revision changed");
        }
      }
      await execution?.finalRecheck?.(database);
      if (!execution) return;
      database.actionExecutions.push({
          runId: execution.runId,
          requestId: execution.requestId,
          payloadDigest: execution.payloadDigest,
          destination: execution.destination,
          policyRevision: execution.policyRevision,
          resourceRevision: execution.resourceRevision,
          destinationRevision: execution.destinationRevision,
          requesterHumanId: execution.requesterHumanId ?? null,
          organizationId: execution.organizationId ?? null,
          accountId: execution.accountId ?? null,
          risk: execution.risk ?? null,
          riskVersion: execution.riskVersion ?? null,
          riskFactsDigest: execution.riskFactsDigest ?? null,
          requiredApprovalCount: execution.requiredApprovalCount ?? null,
          requiredApprovalRoles: execution.requiredApprovalRoles ?? null,
          approvalDecisions: execution.approvalDecisions ?? null,
          action,
        resourceId,
        status: "succeeded",
        resultSummary,
        completedAt: new Date().toISOString(),
      });
    });
  }

  private executionKey(action: NawGateAction, resourceId: string): string {
    return action + ":" + resourceId;
  }
}

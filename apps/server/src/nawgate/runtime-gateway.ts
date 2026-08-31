import {
  ApprovalError,
  ApprovalService,
  type ApprovalRequest,
} from "./approval-service.js";
import { AuditService } from "./audit-service.js";
import { AgentTeamGrantService, type AgentGrantResolver } from "./agent-team-grant-service.js";
import { canonicalPayloadDigest } from "./canonical-json.js";
import { isHumanId, isTeamId } from "./demo-users.js";
import {
  demoContentScopes,
  isContentAction,
  parseContentActionBinding,
} from "./content-model.js";
import {
  isRegisteredDestination,
  type DestinationCatalogueService,
} from "./destination-catalogue.js";
import {
  DeterministicRiskEngine,
  type RiskAssessment,
  type RiskEngine,
  type RiskFacts,
} from "./risk-engine.js";
import { TeamMembershipService, type MembershipResolver } from "./team-membership-service.js";
import type { JsonStore } from "../store.js";
import type {
  ActionExecutionRecord,
  AgentTeamGrant,
  NawGateAction,
  AuditDecision,
  GatewayRequest,
  GatewayResult,
  GatewayDenyReasonCode,
  PolicyEngine,
  PolicyActionAttributes,
  PolicyDecision,
  ProtectedActionResult,
  ProtectedResource,
  TeamMembership,
  TrustedRuntimeContext,
  TeamId,
  RegisteredDestination,
  ApprovalAuthorityRole,
  ApprovalDecision,
  RiskTier,
} from "./types.js";
import { NAWGATE_POLICY_VERSION, NAWGATE_RISK_VERSION } from "./types.js";
import type { Database } from "../types.js";

interface ProtectedResourceBoundary {
  getMetadata(resourceId: string): ProtectedResource | null;
  execute(
    action: NawGateAction,
    resourceId: string,
    execution?: {
      runId: string;
      requestId: string;
      payloadDigest: string;
      destination: string | null;
      policyRevision: string;
      resourceRevision: number;
      destinationRevision: number | null;
      contentPurpose: import("./types.js").ContentPurpose | null;
      finalRecheck?: (database: Database) => void | Promise<void>;
      requesterHumanId?: import("./types.js").HumanId;
      organizationId?: string;
      accountId?: string | null;
      risk?: RiskTier;
      riskVersion?: string;
      riskFactsDigest?: string;
      requiredApprovalCount?: number | null;
      requiredApprovalRoles?: ApprovalAuthorityRole[] | null;
      approvalDecisions?: ApprovalDecision[] | null;
    },
  ): Promise<ProtectedActionResult>;
}

export interface RuntimeAuthorityResolver {
  isAuthorityActive(context: TrustedRuntimeContext): boolean;
}

export interface DemoExecutionBarrier {
  reached: Promise<void>;
  release(): void;
  dispose(): void;
}

interface PendingDemoBarrier {
  reached(): void;
  released: Promise<void>;
  release(): void;
}

class FinalRecheckError extends Error {
  constructor(public readonly reasonCode: GatewayDenyReasonCode) {
    super(reasonCode);
    this.name = "FinalRecheckError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRuntimeContext(value: unknown): value is TrustedRuntimeContext {
  return (
    isRecord(value) &&
    typeof value.humanId === "string" &&
    isHumanId(value.humanId) &&
    isNonEmptyString(value.agentId) &&
    isNonEmptyString(value.runId)
  );
}

function isGatewayRequest(value: unknown): value is GatewayRequest {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) =>
      key === "requestId" || key === "action" || key === "resourceId" ||
      key === "approvalId" || key === "payload" || key === "destination",
    ) ||
    !isNonEmptyString(value.requestId) ||
    !isNonEmptyString(value.action) ||
    !isNonEmptyString(value.resourceId) ||
    (value.approvalId !== undefined && !isNonEmptyString(value.approvalId)) ||
    (value.destination !== undefined && value.destination !== null &&
      (!isNonEmptyString(value.destination) || value.destination.length > 256))
  ) {
    return false;
  }
  try {
    canonicalPayloadDigest(value.payload);
    return true;
  } catch {
    return false;
  }
}

function isRegisteredAction(value: string): value is NawGateAction {
  return (
    value === "resource.read" ||
    value === "file.read" ||
    value === "deploy.staging" ||
    value === "deploy.production" ||
    value === "content.moderate" ||
    value === "content.disclose" ||
    value === "content.publish" ||
    value === "content.export"
  );
}

function environmentFor(action: string): "local" | "staging" | "production" {
  if (action === "deploy.staging") return "staging";
  if (action === "deploy.production") return "production";
  return "local";
}

function policyActionAttributes(
  request: GatewayRequest,
  destinations?: DestinationCatalogueService,
  registeredDestinationOverride?: RegisteredDestination | null,
): PolicyActionAttributes {
  if (!isContentAction(request.action)) return { name: request.action };
  const contentBinding = parseContentActionBinding(request.payload);
  return {
    name: request.action,
    ...(contentBinding ? { contentBinding } : {}),
    destination: request.destination ?? null,
    ...(request.destination && registeredDestinationOverride !== undefined
      ? { registeredDestination: registeredDestinationOverride }
      : request.destination && destinations
        ? { registeredDestination: destinations.get(request.destination) }
      : {}),
  };
}

function auditDecisionFor(outcome: PolicyDecision["outcome"]): AuditDecision {
  return outcome;
}

function riskFor(action: NawGateAction): RiskTier {
  if (action === "resource.read") return "low";
  if (action === "content.moderate") return "low";
  if (action === "content.disclose") return "medium";
  if (action === "content.publish" || action === "content.export") return "high";
  return action === "deploy.production" ? "high" : "medium";
}

function approvalRequirement(risk: RiskTier): {
  count: number;
  roles: ApprovalAuthorityRole[];
} {
  return risk === "critical"
    ? { count: 2, roles: ["owner", "independent_reviewer"] }
    : { count: 1, roles: ["owner"] };
}

function organizationAndAccount(resource: ProtectedResource, humanId: string): {
  organizationId: string;
  accountId: string | null;
} {
  return resource.type === "content_asset"
    ? { organizationId: resource.organizationId, accountId: resource.accountId }
    : { organizationId: `org-${humanId}`, accountId: null };
}

function explanationFor(
  context: TrustedRuntimeContext,
  request: GatewayRequest,
  resource: ProtectedResource | null,
  reasonCode: string,
): string {
  if (reasonCode === "owned_resource_read") {
    return "The Agent is authorized as the owner of this protected resource.";
  }
  if (reasonCode === "team_file_read") {
    return "The Agent's persistent team grant and trusted human membership permit this protected file read.";
  }
  if (reasonCode === "owned_staging_deploy") {
    return "The Agent is authorized to deploy this owned resource to staging.";
  }
  if (reasonCode === "resource_owner_mismatch" && resource) {
    return `The Agent is acting for ${context.humanId}, but ${resource.id} is owned by ${resource.ownerUserId}.`;
  }
  if (reasonCode === "production_deploy_requires_owner_approval") {
    return "Production deployment is high risk and requires explicit owner approval before the protected side effect.";
  }
  if (reasonCode === "capability_consumed") {
    return "The one-use approval capability has already been consumed; replay is denied.";
  }
  if (reasonCode === "capability_revoked") {
    return "The owner revoked the Run authority; the approval capability is no longer usable.";
  }
  if (reasonCode === "approval_denied") {
    return "The owner denied this protected action.";
  }
  if (reasonCode === "approval_expired") {
    return "The approval window expired before the protected action was attempted.";
  }
  if (reasonCode === "unknown_resource") {
    return "The requested resource is not registered as a protected resource.";
  }
  if (reasonCode === "unknown_team") {
    return "The protected file belongs to an unknown team; access is denied.";
  }
  if (reasonCode === "team_membership_missing") {
    return "The acting human has no trusted membership relationship with this team.";
  }
  if (reasonCode === "team_role_insufficient") {
    return "The acting human's trusted team role is below the protected file's minimum role.";
  }
  if (reasonCode === "agent_grant_missing") {
    return "This Agent has not been explicitly enrolled in the protected file's team.";
  }
  if (reasonCode === "agent_grant_revoked") {
    return "This Agent's persistent team grant was revoked.";
  }
  if (reasonCode === "agent_grant_expired") {
    return "This Agent's persistent team grant has expired.";
  }
  if (reasonCode === "agent_grant_action_under_scoped") {
    return "This Agent's team grant does not include the requested registered action.";
  }
  if (reasonCode === "agent_grant_role_insufficient") {
    return "This Agent's team grant role is below the protected file's minimum role.";
  }
  if (reasonCode === "restricted_file_requires_temporary_elevation") {
    return "The human team role is sufficient, but this Agent's persistent grant is viewer-only; explicit owner approval is required for a one-use restricted-file elevation.";
  }
  if (reasonCode === "runtime_authority_revoked") {
    return "The Run authority is no longer active; the protected action was not executed.";
  }
  if (reasonCode === "resource_revision_changed") {
    return "The protected resource changed after authorization; the stale capability was not executed.";
  }
  if (reasonCode === "content_moderation_allowed") {
    return "The Agent is authorized to process this owned content asset for safety moderation; only an aggregate result is returned.";
  }
  if (reasonCode === "content_disclosure_allowed") {
    return "An explicit backend-approved analytics scope authorizes disclosure of this exact content asset.";
  }
  if (reasonCode === "content_purpose_mismatch") {
    return "The declared content purpose is not permitted for this registered content action.";
  }
  if (reasonCode === "content_asset_mismatch") {
    return "The declared organisation, business centre, account, or asset does not match the registered content resource.";
  }
  if (reasonCode === "content_version_mismatch") {
    return "The protected content changed after the request was formed; the stale content binding was denied.";
  }
  if (reasonCode === "content_scope_missing") {
    return "Disclosure requires an explicit backend-approved scope for this exact account and asset.";
  }
  if (reasonCode === "content_destination_unknown") {
    return "The content destination is not a registered synthetic destination.";
  }
  if (reasonCode === "content_destination_mismatch") {
    return "The content destination does not match the registered account or organisation scope.";
  }
  if (reasonCode === "content_destination_revoked") {
    return "The registered content destination is revoked; no downstream credential was released.";
  }
  if (reasonCode === "content_destination_disabled") {
    return "The registered content destination is disabled; no downstream credential was released.";
  }
  if (reasonCode === "content_destination_action_mismatch") {
    return "The registered content destination does not permit this exact action.";
  }
  if (reasonCode === "content_destination_purpose_mismatch") {
    return "The registered content destination does not permit this declared purpose.";
  }
  if (reasonCode === "content_destination_tenant_mismatch") {
    return "The registered content destination belongs to a different organisation, business centre, or account.";
  }
  if (reasonCode === "destination_revision_changed") {
    return "The registered destination changed after authorization; the stale capability was not executed.";
  }
  if (reasonCode === "risk_facts_malformed") {
    return "The backend could not establish a complete trusted risk-facts binding; the protected action was denied.";
  }
  if (reasonCode === "risk_facts_changed") {
    return "The trusted risk facts changed after authorization; the protected action was not executed.";
  }
  if (reasonCode === "approval_authority_revoked") {
    return "An approval authority changed before execution; the protected action was not executed.";
  }
  if (reasonCode === "risk_requires_dual_control") {
    return "This critical action requires one owner and one independent reviewer approval.";
  }
  if (reasonCode === "risk_requires_owner_approval") {
    return "This action's deterministic risk tier requires explicit owner approval before execution.";
  }
  if (reasonCode === "content_publish_requires_owner_approval") {
    return "Publishing content is high risk and requires explicit owner approval before the protected side effect.";
  }
  if (reasonCode === "content_export_requires_owner_approval") {
    return "Exporting content to compliance archive is high risk and requires explicit owner approval before the protected side effect.";
  }
  if (reasonCode === "malformed_attributes") {
    return "The subject, object, action, or environment attributes were malformed.";
  }
  if (reasonCode === "action_resource_mismatch") {
    return "The registered action does not match the protected resource type.";
  }
  if (reasonCode === "invalid_capability" || reasonCode === "idempotency_mismatch") {
    return "The supplied capability does not exactly match this protected action request.";
  }
  return `The Bouncer denied ${request.action} at the RuntimeGateway.`;
}

export class RuntimeGateway {
  private executionTail: Promise<void> = Promise.resolve();
  private readonly demoBarriers = new Map<string, PendingDemoBarrier>();

  constructor(
    private readonly policy: PolicyEngine,
    private readonly resources: ProtectedResourceBoundary,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalService,
    private readonly store: JsonStore,
    private readonly memberships: MembershipResolver = new TeamMembershipService(store),
    private readonly grants: AgentGrantResolver = new AgentTeamGrantService(store),
    private readonly authority?: RuntimeAuthorityResolver,
    private readonly destinations?: DestinationCatalogueService,
    private readonly riskEngine: RiskEngine = new DeterministicRiskEngine(),
  ) {}

  /**
   * A server-only synchronization hook used by the explicitly enabled local
   * Security Lab. It sits after the initial decision and before the final
   * mutable-authority recheck; no runtime request can create it.
   */
  createDemoExecutionBarrier(runId: string, requestId: string): DemoExecutionBarrier {
    const key = this.demoBarrierKey(runId, requestId);
    if (this.demoBarriers.has(key)) {
      throw new Error("A demo execution barrier is already registered for this request");
    }
    let signalReached!: () => void;
    let signalRelease!: () => void;
    const reached = new Promise<void>((resolve) => {
      signalReached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      signalRelease = resolve;
    });
    this.demoBarriers.set(key, { reached: signalReached, released, release: signalRelease });
    return {
      reached,
      release: () => signalRelease(),
      dispose: () => {
        this.demoBarriers.delete(key);
        signalRelease();
      },
    };
  }

  async execute(
    context: TrustedRuntimeContext,
    request: GatewayRequest,
  ): Promise<GatewayResult> {
    const startedAt = Date.now();
    if (!isRuntimeContext(context) || !isGatewayRequest(request)) {
      const requestId = isRecord(request) && typeof request.requestId === "string"
        ? request.requestId
        : "unknown";
      const action = isRecord(request) && typeof request.action === "string"
        ? request.action
        : "unknown";
      const resourceId = isRecord(request) && typeof request.resourceId === "string"
        ? request.resourceId
        : "unknown";
      await this.audit.record({
        eventType: "policy.deny",
        humanId: null,
        agentId: null,
        runId: null,
        requestId,
        action: isRegisteredAction(action) ? action : null,
        resourceId: null,
        decision: "deny",
        risk: "high",
        reasonCode: "invalid_context",
        approvalId: null,
        capabilityId: null,
        status: "failure",
        durationMs: Date.now() - startedAt,
        policyVersion: NAWGATE_POLICY_VERSION,
        explanation: "The runtime context or protected action request was malformed.",
        enforcementPoint: "RuntimeGateway",
        protectedActionExecuted: false,
      });
      return {
        status: "denied",
        requestId,
        action,
        resourceId: "unknown",
        reasonCode: "invalid_context",
      };
    }
    const payloadDigest = canonicalPayloadDigest(request.payload);

    if (this.authority && !this.authority.isAuthorityActive(context)) {
      await this.recordPolicyDecision(
        context,
        request,
        null,
        { outcome: "deny", risk: "high", reasonCode: "runtime_authority_revoked" },
        startedAt,
        [],
      );
      return {
        status: "denied",
        requestId: request.requestId,
        action: request.action,
        resourceId: request.resourceId,
        reasonCode: "runtime_authority_revoked",
      };
    }

    // A completed execution is a historical result, not a request to perform
    // the protected side effect again. Resolve exact replay before current
    // destination policy so rotation/revocation cannot turn a safe terminal
    // retry into a new denial or a second adapter call.
    if (isRegisteredAction(request.action)) {
      const historicalExecution = this.findExecution(context.runId, request.requestId);
      if (historicalExecution) {
        if (!this.executionMatchesRequest(historicalExecution, request, payloadDigest)) {
          return {
            status: "conflict",
            requestId: request.requestId,
            action: request.action,
            resourceId: request.resourceId,
            reasonCode: "idempotency_mismatch",
          };
        }
        if (
          isContentAction(request.action) &&
          request.action !== "content.moderate" &&
          (historicalExecution.destinationRevision === null ||
            !Number.isInteger(historicalExecution.destinationRevision) ||
            historicalExecution.destinationRevision <= 0)
        ) {
          return {
            status: "conflict",
            requestId: request.requestId,
            action: request.action,
            resourceId: request.resourceId,
            reasonCode: "idempotency_mismatch",
          };
        }
        return this.replayExecution(historicalExecution);
      }
    }

    const resource = this.resources.getMetadata(request.resourceId);
    if (!resource) {
      await this.recordPolicyDecision(
        context,
        request,
        null,
        { outcome: "deny", risk: "high", reasonCode: "unknown_resource" },
        startedAt,
      );
      return {
        status: "denied",
        requestId: request.requestId,
        action: request.action,
        resourceId: "unknown",
        reasonCode: "unknown_resource",
      };
    }

    // The request cannot supply roles. Resolve relationship tuples from the
    // trusted server store at the enforcement boundary before policy runs.
    const memberships = this.memberships.resolveMemberships(context.humanId);
    const grants = this.grants.resolveGrants(context.agentId);
    const decision = await this.policy.evaluate({
      requestId: request.requestId,
      subject: {
        humanId: context.humanId,
        agentId: context.agentId,
        runId: context.runId,
        memberships,
        agentGrants: grants,
        contentScopes: demoContentScopes(context.humanId),
      },
      object: { resource },
      action: policyActionAttributes(request, this.destinations),
      environment: { name: environmentFor(request.action) },
    });
    if (decision.outcome === "deny") {
      await this.recordPolicyDecision(
        context,
        request,
        resource,
        decision,
        startedAt,
        grants,
        memberships,
      );
      return {
        status: "denied",
        requestId: request.requestId,
        action: request.action,
        resourceId: request.resourceId,
        reasonCode: decision.reasonCode,
      };
    }

    const initialRisk = this.assessRisk(request, resource);
    if (initialRisk.outcome === "deny") {
      const riskDecision: PolicyDecision = {
        outcome: "deny",
        risk: "critical",
        reasonCode: "malformed_attributes",
      };
      await this.recordPolicyDecision(
        context,
        request,
        resource,
        riskDecision,
        startedAt,
        grants,
        memberships,
        initialRisk,
        "risk_facts_malformed",
      );
      return {
        status: "denied",
        requestId: request.requestId,
        action: request.action,
        resourceId: request.resourceId,
        reasonCode: "risk_facts_malformed",
      };
    }
    await this.recordPolicyDecision(
      context,
      request,
      resource,
      decision,
      startedAt,
      grants,
      memberships,
      initialRisk,
    );

    return this.serializeExecution(async () => {
      let capabilityResourceRevision: number | undefined;
      let capabilityDestinationRevision: number | undefined;
      let approvalRequestForExecution: (ApprovalRequest & { approvalId: string }) | undefined;
      const existing = this.findExecution(context.runId, request.requestId);
      if (existing) {
        if (!this.executionMatchesRequest(existing, request, payloadDigest)) {
          return {
            status: "conflict",
            requestId: request.requestId,
            action: request.action,
            resourceId: request.resourceId,
            reasonCode: "idempotency_mismatch",
          };
        }
        if (
          isContentAction(request.action) &&
          request.action !== "content.moderate" &&
          (existing.destinationRevision === null ||
            !Number.isInteger(existing.destinationRevision) ||
            existing.destinationRevision <= 0)
        ) {
          return {
            status: "conflict",
            requestId: request.requestId,
            action: request.action,
            resourceId: request.resourceId,
            reasonCode: "idempotency_mismatch",
          };
        }
        return this.replayExecution(existing);
      }

      await this.awaitDemoExecutionBarrier(context, request);

      // The initial decision may have waited behind another protected action.
      // Re-resolve every mutable authorization input immediately before any
      // approval consumption or protected side effect.
      const finalResource = this.resources.getMetadata(request.resourceId);
      const finalGrants = this.grants.resolveGrants(context.agentId);
      const finalMemberships = this.memberships.resolveMemberships(context.humanId);
      if (this.authority && !this.authority.isAuthorityActive(context)) {
        await this.recordPolicyDecision(
          context,
          request,
          finalResource,
          { outcome: "deny", risk: "high", reasonCode: "runtime_authority_revoked" },
          startedAt,
          finalGrants,
          finalMemberships,
        );
        return {
          status: "denied",
          requestId: request.requestId,
          action: request.action,
          resourceId: request.resourceId,
          reasonCode: "runtime_authority_revoked",
        };
      }
      if (!finalResource) {
        await this.recordPolicyDecision(
          context,
          request,
          null,
          { outcome: "deny", risk: "high", reasonCode: "unknown_resource" },
          startedAt,
          finalGrants,
          finalMemberships,
        );
        return {
          status: "denied",
          requestId: request.requestId,
          action: request.action,
          resourceId: "unknown",
          reasonCode: "unknown_resource",
        };
      }
      const finalDecision = await this.policy.evaluate({
        requestId: request.requestId,
        subject: {
          humanId: context.humanId,
          agentId: context.agentId,
          runId: context.runId,
          memberships: finalMemberships,
          agentGrants: finalGrants,
          contentScopes: demoContentScopes(context.humanId),
        },
        object: { resource: finalResource },
        action: policyActionAttributes(request, this.destinations),
        environment: { name: environmentFor(request.action) },
      });
      if (finalDecision.outcome === "deny") {
        await this.recordPolicyDecision(
          context,
          request,
          finalResource,
          finalDecision,
          startedAt,
          finalGrants,
          finalMemberships,
        );
        return {
          status: "denied",
          requestId: request.requestId,
          action: request.action,
          resourceId: request.resourceId,
          reasonCode: finalDecision.reasonCode,
        };
      }
      const currentDecision = finalDecision;
      const currentRisk = this.assessRisk(request, finalResource);
      if (currentRisk.outcome === "deny") {
        const riskDecision: PolicyDecision = {
          outcome: "deny",
          risk: "critical",
          reasonCode: "malformed_attributes",
        };
        await this.recordPolicyDecision(
          context,
          request,
          finalResource,
          riskDecision,
          startedAt,
          finalGrants,
          finalMemberships,
          currentRisk,
          "risk_facts_malformed",
        );
        return {
          status: "denied",
          requestId: request.requestId,
          action: request.action,
          resourceId: request.resourceId,
          reasonCode: "risk_facts_malformed",
        };
      }
      const effectiveRisk = currentRisk.riskTier;
      const needsApproval = currentDecision.outcome === "require_approval" || effectiveRisk !== "low";
      const requirement = approvalRequirement(effectiveRisk);

      if (needsApproval) {
        const approvalReason: Extract<GatewayResult, { status: "approval_required" }>['reasonCode'] = currentDecision.outcome === "require_approval"
          ? currentDecision.reasonCode
          : effectiveRisk === "critical"
            ? "risk_requires_dual_control"
            : "risk_requires_owner_approval";
        const scope = organizationAndAccount(finalResource, context.humanId);
        const approvalRequest: ApprovalRequest = {
          humanId: context.humanId,
          agentId: context.agentId,
          runId: context.runId,
          requestId: request.requestId,
          action: request.action,
          resourceId: request.resourceId,
          reasonCode: approvalReason,
          payload: request.payload,
          destination: request.destination ?? null,
          policyRevision: NAWGATE_POLICY_VERSION,
          resourceRevision: finalResource.revision,
          destinationRevision: isContentAction(request.action) && request.action !== "content.moderate"
            ? this.destinations?.get(request.destination ?? "")?.revision ?? null
            : null,
          ...this.grantEvidence(
            finalResource,
            finalGrants,
            finalMemberships,
            approvalReason === "restricted_file_requires_temporary_elevation",
          ),
          risk: effectiveRisk,
          riskVersion: currentRisk.riskVersion,
          riskFactsDigest: currentRisk.factsDigest,
          requiredApprovalCount: requirement.count,
          requiredApprovalRoles: requirement.roles,
          organizationId: scope.organizationId,
          accountId: scope.accountId,
        };
        if (!request.approvalId) {
          try {
            const approval = await this.approvals.getOrCreate(approvalRequest);
            if (approval.status === "denied") {
              return {
                status: "denied",
                requestId: request.requestId,
                action: request.action,
                resourceId: request.resourceId,
                reasonCode: "approval_denied",
              };
            }
            if (approval.status === "expired") {
              return {
                status: "denied",
                requestId: request.requestId,
                action: request.action,
                resourceId: request.resourceId,
                reasonCode: "approval_expired",
              };
            }
            return {
              status: "approval_required",
              requestId: request.requestId,
              action: request.action,
              resourceId: request.resourceId,
              approvalId: approval.id,
              risk: approval.risk,
              reasonCode: approvalReason,
              requiredApprovalCount: approval.requiredApprovalCount,
              requiredApprovalRoles: [...approval.requiredApprovalRoles],
            };
          } catch (error) {
            if (error instanceof ApprovalError && error.code === "IDEMPOTENCY_MISMATCH") {
              return {
                status: "conflict",
                requestId: request.requestId,
                action: request.action,
                resourceId: request.resourceId,
                reasonCode: "idempotency_mismatch",
              };
            }
            throw error;
          }
        }

        const consumption = await this.approvals.consumeCapability({
          ...approvalRequest,
          approvalId: request.approvalId,
        });
        if (consumption.status === "pending") {
          return {
            status: "approval_required",
            requestId: request.requestId,
            action: request.action,
            resourceId: request.resourceId,
            approvalId: consumption.approval.id,
            risk: consumption.approval.risk,
            reasonCode: approvalReason,
            requiredApprovalCount: consumption.approval.requiredApprovalCount,
            requiredApprovalRoles: [...consumption.approval.requiredApprovalRoles],
          };
        }
        if (consumption.status === "denied") {
          await this.audit.record({
            eventType: "policy.deny",
            humanId: context.humanId,
            agentId: context.agentId,
            runId: context.runId,
            requestId: request.requestId,
            action: request.action,
            resourceId: request.resourceId,
            decision: "deny",
            risk: currentDecision.risk,
            reasonCode: consumption.reasonCode,
            approvalId: request.approvalId,
            capabilityId: null,
            status: "failure",
            durationMs: Date.now() - startedAt,
            policyVersion: NAWGATE_POLICY_VERSION,
            explanation: explanationFor(context, request, finalResource, consumption.reasonCode),
            enforcementPoint: "RuntimeGateway",
            protectedActionExecuted: false,
            ...this.grantEvidence(finalResource, finalGrants, finalMemberships),
          });
          return {
            status: "denied",
            requestId: request.requestId,
            action: request.action,
            resourceId: request.resourceId,
            reasonCode: consumption.reasonCode,
          };
        }
        request = { ...request, approvalId: consumption.capability.approvalId };
        approvalRequestForExecution = {
          ...approvalRequest,
          approvalId: consumption.capability.approvalId,
        };
        capabilityResourceRevision = consumption.capability.resourceRevision;
        capabilityDestinationRevision = consumption.capability.destinationRevision ?? undefined;
      }

      return this.executeProtected(
        context,
        request,
        startedAt,
        payloadDigest,
        capabilityResourceRevision,
        capabilityDestinationRevision,
        currentRisk,
        approvalRequestForExecution,
      );
    });
  }

  private async executeProtected(
    context: TrustedRuntimeContext,
    request: GatewayRequest,
    startedAt: number,
    payloadDigest: string,
    capabilityResourceRevision?: number,
    capabilityDestinationRevision?: number,
    expectedRisk?: Extract<RiskAssessment, { outcome: "allow" }>,
    approvalRequest?: ApprovalRequest & { approvalId: string },
  ): Promise<GatewayResult> {
    // This is intentionally a second policy boundary immediately adjacent to
    // the side effect. The earlier decision may have waited on the execution
    // queue or consumed an approval while mutable membership/grant state
    // changed. A stale allow is never sufficient to read a protected file.
    const resource = this.resources.getMetadata(request.resourceId);
    const grants = this.grants.resolveGrants(context.agentId);
    const memberships = this.memberships.resolveMemberships(context.humanId);
    if (this.authority && !this.authority.isAuthorityActive(context)) {
      return this.deniedAfterFinalRecheck(
        context,
        request,
        resource,
        grants,
        { outcome: "deny", risk: "high", reasonCode: "runtime_authority_revoked" },
        startedAt,
        memberships,
      );
    }
    if (!resource) {
      return this.deniedAfterFinalRecheck(
        context,
        request,
        null,
        grants,
        { outcome: "deny", risk: "high", reasonCode: "unknown_resource" },
        startedAt,
        memberships,
      );
    }
    const finalDecision = await this.policy.evaluate({
      requestId: request.requestId,
      subject: {
        humanId: context.humanId,
        agentId: context.agentId,
        runId: context.runId,
        memberships,
        agentGrants: grants,
        contentScopes: demoContentScopes(context.humanId),
      },
      object: { resource },
      action: policyActionAttributes(request, this.destinations),
      environment: { name: environmentFor(request.action) },
    });
    if (finalDecision.outcome === "deny") {
      return this.deniedAfterFinalRecheck(
        context,
        request,
        resource,
        grants,
        finalDecision,
        startedAt,
        memberships,
      );
    }
    // Re-read the resource after the final policy evaluation. A resource
    // revision can change while policy is evaluating or immediately after an
    // approval claim is consumed. A consumed capability is still unusable if
    // its bound revision is stale, and no protected boundary is called.
    const latestResource = this.resources.getMetadata(request.resourceId);
    if (!latestResource) {
      return this.deniedAfterFinalRecheck(
        context,
        request,
        null,
        grants,
        { outcome: "deny", risk: "high", reasonCode: "unknown_resource" },
        startedAt,
        memberships,
      );
    }
    if (
      latestResource.revision !== resource.revision ||
      (capabilityResourceRevision !== undefined &&
        latestResource.revision !== capabilityResourceRevision)
    ) {
      return this.deniedAfterFinalRecheck(
        context,
        request,
        latestResource,
        grants,
        { outcome: "deny", risk: "high", reasonCode: "resource_revision_changed" },
        startedAt,
        memberships,
      );
    }
    let latestDestinationRevision: number | null = null;
    if (isContentAction(request.action) && request.action !== "content.moderate") {
      const latestDestination = this.destinations?.get(request.destination ?? "");
      if (!latestDestination) {
        return this.deniedAfterFinalRecheck(
          context,
          request,
          latestResource,
          grants,
          { outcome: "deny", risk: "high", reasonCode: "content_destination_unknown" },
          startedAt,
          memberships,
        );
      }
      if (latestDestination.status !== "enabled") {
        return this.deniedAfterFinalRecheck(
          context,
          request,
          latestResource,
          grants,
          { outcome: "deny", risk: "high", reasonCode: "content_destination_revoked" },
          startedAt,
          memberships,
        );
      }
      if (
        capabilityDestinationRevision !== undefined &&
        latestDestination.revision !== capabilityDestinationRevision
      ) {
        return this.deniedAfterFinalRecheck(
          context,
          request,
          latestResource,
          grants,
          { outcome: "deny", risk: "high", reasonCode: "destination_revision_changed" },
          startedAt,
          memberships,
        );
      }
      latestDestinationRevision = latestDestination.revision;
    }
    const latestRisk = this.assessRisk(
      request,
      latestResource,
      isContentAction(request.action) && request.action !== "content.moderate"
        ? this.destinations?.get(request.destination ?? "") ?? undefined
        : undefined,
    );
    if (latestRisk.outcome === "deny") {
      return this.deniedAfterFinalRecheck(
        context,
        request,
        latestResource,
        grants,
        { outcome: "deny", risk: "critical", reasonCode: "malformed_attributes" },
        startedAt,
        memberships,
        latestRisk,
        "risk_facts_malformed",
      );
    }
    if (
      expectedRisk &&
      (latestRisk.riskTier !== expectedRisk.riskTier ||
        latestRisk.riskVersion !== expectedRisk.riskVersion ||
        latestRisk.factsDigest !== expectedRisk.factsDigest)
    ) {
      return this.deniedAfterFinalRecheck(
        context,
        request,
        latestResource,
        grants,
        { outcome: "deny", risk: latestRisk.riskTier, reasonCode: "malformed_attributes" },
        startedAt,
        memberships,
        latestRisk,
        "risk_facts_changed",
      );
    }
    if (approvalRequest && !this.approvals.isConsumedClaimValid(approvalRequest)) {
      return this.deniedAfterFinalRecheck(
        context,
        request,
        latestResource,
        grants,
        { outcome: "deny", risk: latestRisk.riskTier, reasonCode: "malformed_attributes" },
        startedAt,
        memberships,
        latestRisk,
        "approval_authority_revoked",
      );
    }
    const finalRecheck = this.createFinalRecheck(
      context,
      request,
      latestResource,
      latestDestinationRevision,
      expectedRisk ?? latestRisk,
      approvalRequest,
    );
    try {
      const result = await this.resources.execute(request.action, request.resourceId, {
        runId: context.runId,
        requestId: request.requestId,
        payloadDigest,
        destination: request.destination ?? null,
        policyRevision: NAWGATE_POLICY_VERSION,
        resourceRevision: latestResource.revision,
        destinationRevision: latestDestinationRevision,
        contentPurpose: isContentAction(request.action)
          ? parseContentActionBinding(request.payload)?.purpose ?? null
          : null,
        finalRecheck,
        requesterHumanId: context.humanId,
        organizationId: organizationAndAccount(latestResource, context.humanId).organizationId,
        accountId: organizationAndAccount(latestResource, context.humanId).accountId,
        risk: latestRisk.riskTier,
        riskVersion: latestRisk.riskVersion,
        riskFactsDigest: latestRisk.factsDigest,
        requiredApprovalCount: approvalRequest?.requiredApprovalCount ?? null,
        requiredApprovalRoles: approvalRequest?.requiredApprovalRoles ?? null,
        approvalDecisions: this.approvalDecisionsFor(request.approvalId),
      });
      await this.audit.record({
        eventType: "protected_action.succeeded",
        humanId: context.humanId,
        agentId: context.agentId,
        runId: context.runId,
        requestId: request.requestId,
        action: request.action,
        resourceId: request.resourceId,
        decision: "allow",
        risk: latestRisk.riskTier,
        reasonCode: "protected_action_succeeded",
        approvalId: request.approvalId ?? null,
        capabilityId: null,
        status: "success",
        durationMs: Date.now() - startedAt,
        policyVersion: NAWGATE_POLICY_VERSION,
        explanation: "The RuntimeGateway authorized and completed the protected action.",
        enforcementPoint: "RuntimeGateway",
        protectedActionExecuted: true,
        riskVersion: latestRisk.riskVersion,
        riskFactsDigest: latestRisk.factsDigest,
        ...(approvalRequest
          ? {
              requiredApprovalCount: approvalRequest.requiredApprovalCount ?? null,
              requiredApprovalRoles: approvalRequest.requiredApprovalRoles ?? null,
              approvalDecisions: this.approvalDecisionsFor(request.approvalId),
            }
          : {}),
        ...this.grantEvidence(resource, grants, memberships, Boolean(request.approvalId)),
      });
      return {
        status: "success",
        requestId: request.requestId,
        action: request.action,
        resourceId: request.resourceId,
        result,
      };
    } catch (error) {
      if (error instanceof FinalRecheckError) {
        return this.deniedAfterFinalRecheck(
          context,
          request,
          latestResource,
          grants,
          { outcome: "deny", risk: latestRisk.riskTier, reasonCode: "malformed_attributes" },
          startedAt,
          memberships,
          latestRisk,
          error.reasonCode,
        );
      }
      await this.store.mutate((database) => {
        database.actionExecutions.push({
          runId: context.runId,
          requestId: request.requestId,
          action: request.action,
          resourceId: request.resourceId,
          payloadDigest,
          destination: request.destination ?? null,
          policyRevision: NAWGATE_POLICY_VERSION,
          resourceRevision: latestResource.revision,
          destinationRevision: latestDestinationRevision,
          requesterHumanId: context.humanId,
          organizationId: organizationAndAccount(latestResource, context.humanId).organizationId,
          accountId: organizationAndAccount(latestResource, context.humanId).accountId,
          risk: latestRisk.riskTier,
          riskVersion: latestRisk.riskVersion,
          riskFactsDigest: latestRisk.factsDigest,
          requiredApprovalCount: approvalRequest?.requiredApprovalCount ?? null,
          requiredApprovalRoles: approvalRequest?.requiredApprovalRoles ?? null,
          approvalDecisions: this.approvalDecisionsFor(request.approvalId),
          status: "failed",
          resultSummary: { summary: "Protected action failed" },
          completedAt: new Date().toISOString(),
        });
      });
      await this.audit.record({
        eventType: "protected_action.failed",
        humanId: context.humanId,
        agentId: context.agentId,
        runId: context.runId,
        requestId: request.requestId,
        action: request.action,
        resourceId: request.resourceId,
        decision: "allow",
        risk: latestRisk.riskTier,
        reasonCode: "protected_action_failed",
        approvalId: request.approvalId ?? null,
        capabilityId: null,
        status: "failure",
        durationMs: Date.now() - startedAt,
        policyVersion: NAWGATE_POLICY_VERSION,
        explanation: "Authorization passed, but the protected action failed during execution.",
        enforcementPoint: "RuntimeGateway",
        protectedActionExecuted: false,
        riskVersion: latestRisk.riskVersion,
        riskFactsDigest: latestRisk.factsDigest,
        ...(approvalRequest
          ? {
              requiredApprovalCount: approvalRequest.requiredApprovalCount ?? null,
              requiredApprovalRoles: approvalRequest.requiredApprovalRoles ?? null,
              approvalDecisions: this.approvalDecisionsFor(request.approvalId),
            }
          : {}),
        ...this.grantEvidence(resource, grants, memberships, Boolean(request.approvalId)),
      });
      return {
        status: "failed",
        requestId: request.requestId,
        action: request.action,
        resourceId: request.resourceId,
        reasonCode: "protected_action_failed",
      };
    }
  }

  private async awaitDemoExecutionBarrier(
    context: TrustedRuntimeContext,
    request: GatewayRequest,
  ): Promise<void> {
    const key = this.demoBarrierKey(context.runId, request.requestId);
    const barrier = this.demoBarriers.get(key);
    if (!barrier) return;
    barrier.reached();
    await barrier.released;
    this.demoBarriers.delete(key);
  }

  private assessRisk(
    request: GatewayRequest,
    resource: ProtectedResource,
    destination?: RegisteredDestination,
  ): RiskAssessment {
    const resolvedDestination = destination ?? (
      isContentAction(request.action) && request.action !== "content.moderate"
        ? this.destinations?.get(request.destination ?? "") ?? undefined
        : undefined
    );
    return this.riskEngine.assess(this.buildRiskFacts(request, resource, resolvedDestination));
  }

  private buildRiskFacts(
    request: GatewayRequest,
    resource: ProtectedResource,
    destination?: RegisteredDestination,
  ): RiskFacts | null {
    const destinationId = request.destination ?? null;
    if (isContentAction(request.action)) {
      if (
        resource.type !== "content_asset" ||
        resource.assetType !== "short_video" ||
        (resource.sourceRegion !== "SG" && resource.sourceRegion !== "GLOBAL")
      ) {
        return null;
      }
      if (request.action === "content.moderate") {
        if (destinationId !== null) return null;
        return {
          action: request.action,
          resourceClassification: resource.classification,
          destinationId: null,
          destinationEnvironment: "local",
          destinationAudience: "owner",
          destinationReach: "narrow",
          assetType: "short_video",
          sourceRegion: resource.sourceRegion,
          destinationRegion: null,
          resourceRevision: resource.revision,
          destinationRevision: null,
        };
      }
      if (
        !destination ||
        destination.id !== destinationId ||
        !isRegisteredDestination(destination)
      ) {
        return null;
      }
      return {
        action: request.action,
        resourceClassification: resource.classification,
        destinationId: destination.id,
        destinationEnvironment: destination.environment,
        destinationAudience: destination.audience,
        destinationReach: destination.reach,
        assetType: "short_video",
        sourceRegion: resource.sourceRegion,
        destinationRegion: destination.region,
        resourceRevision: resource.revision,
        destinationRevision: destination.revision,
      };
    }
    const destinationEnvironment = environmentFor(request.action);
    return {
      action: request.action,
      resourceClassification: resource.classification,
      destinationId: null,
      destinationEnvironment,
      destinationAudience: resource.type === "team_file" ? "team" : "owner",
      destinationReach: "narrow",
      assetType: resource.type === "content_asset" ? "short_video" : resource.type,
      sourceRegion: "GLOBAL",
      destinationRegion: null,
      resourceRevision: resource.revision,
      destinationRevision: null,
    };
  }

  private policyDecisionFromDatabase(
    context: TrustedRuntimeContext,
    request: GatewayRequest,
    resource: ProtectedResource,
    database: Database,
  ): Promise<PolicyDecision> {
    const registeredDestination = request.destination
      ? database.registeredDestinations.find(
          (candidate) => candidate.id === request.destination && isRegisteredDestination(candidate),
        ) ?? null
      : undefined;
    return this.policy.evaluate({
      requestId: request.requestId,
      subject: {
        humanId: context.humanId,
        agentId: context.agentId,
        runId: context.runId,
        memberships: database.teamMemberships.filter((membership) => membership.humanId === context.humanId),
        agentGrants: database.agentTeamGrants.filter((grant) => grant.agentId === context.agentId),
        contentScopes: demoContentScopes(context.humanId),
      },
      object: { resource },
      action: policyActionAttributes(request, undefined, registeredDestination),
      environment: { name: environmentFor(request.action) },
    });
  }

  private createFinalRecheck(
    context: TrustedRuntimeContext,
    request: GatewayRequest,
    expectedResource: ProtectedResource,
    expectedDestinationRevision: number | null,
    expectedRisk: Extract<RiskAssessment, { outcome: "allow" }>,
    approvalRequest?: ApprovalRequest & { approvalId: string },
  ): (database: Database) => Promise<void> {
    return async (database) => {
      if (this.authority && !this.authority.isAuthorityActive(context)) {
        throw new FinalRecheckError("runtime_authority_revoked");
      }
      const currentResource = database.protectedResources.find(
        (candidate) => candidate.id === expectedResource.id,
      );
      if (!currentResource || currentResource.revision !== expectedResource.revision) {
        throw new FinalRecheckError("resource_revision_changed");
      }
      const hasRegisteredDestination = isContentAction(request.action) && request.action !== "content.moderate" && Boolean(request.destination);
      const currentDestination = hasRegisteredDestination
        ? database.registeredDestinations.find(
            (candidate) => candidate.id === request.destination && isRegisteredDestination(candidate),
          )
        : undefined;
      if (
        hasRegisteredDestination &&
        (!currentDestination || currentDestination.revision !== expectedDestinationRevision)
      ) {
        throw new FinalRecheckError("destination_revision_changed");
      }
      const policyDecision = await this.policyDecisionFromDatabase(
        context,
        request,
        currentResource,
        database,
      );
      if (policyDecision.outcome === "deny") {
        throw new FinalRecheckError(policyDecision.reasonCode);
      }
      const currentRisk = this.riskEngine.assess(
        this.buildRiskFacts(request, currentResource, currentDestination),
      );
      if (currentRisk.outcome === "deny") {
        throw new FinalRecheckError("risk_facts_malformed");
      }
      if (
        currentRisk.riskTier !== expectedRisk.riskTier ||
        currentRisk.riskVersion !== expectedRisk.riskVersion ||
        currentRisk.factsDigest !== expectedRisk.factsDigest
      ) {
        throw new FinalRecheckError("risk_facts_changed");
      }
      if (approvalRequest && !this.approvals.isConsumedClaimValid(approvalRequest)) {
        throw new FinalRecheckError("approval_authority_revoked");
      }
    };
  }

  private demoBarrierKey(runId: string, requestId: string): string {
    return `${runId}\u0000${requestId}`;
  }

  private async deniedAfterFinalRecheck(
    context: TrustedRuntimeContext,
    request: GatewayRequest,
    resource: ProtectedResource | null,
    grants: readonly AgentTeamGrant[],
    decision: Extract<PolicyDecision, { outcome: "deny" }>,
    startedAt: number,
    memberships: readonly TeamMembership[] = [],
    riskAssessment?: RiskAssessment,
    reasonCodeOverride?: GatewayDenyReasonCode,
  ): Promise<GatewayResult> {
    await this.recordPolicyDecision(
      context,
      request,
      resource,
      decision,
      startedAt,
      grants,
      memberships,
      riskAssessment,
      reasonCodeOverride,
    );
    return {
      status: "denied",
      requestId: request.requestId,
      action: request.action,
      resourceId: request.resourceId,
      reasonCode: reasonCodeOverride ?? decision.reasonCode,
    };
  }

  private findExecution(runId: string, requestId: string): ActionExecutionRecord | null {
    return (
      this.store
        .snapshot()
        .actionExecutions.find(
          (execution) => execution.runId === runId && execution.requestId === requestId,
        ) ?? null
    );
  }

  private executionMatchesRequest(
    execution: ActionExecutionRecord,
    request: GatewayRequest,
    payloadDigest: string,
  ): boolean {
    return (
      execution.action === request.action &&
      execution.resourceId === request.resourceId &&
      execution.payloadDigest !== null &&
      execution.destination === (request.destination ?? null) &&
      execution.payloadDigest === payloadDigest &&
      execution.policyRevision !== null &&
      execution.resourceRevision !== null
    );
  }

  private replayExecution(execution: ActionExecutionRecord): GatewayResult {
    if (execution.status === "failed") {
      return {
        status: "failed",
        requestId: execution.requestId,
        action: execution.action,
        resourceId: execution.resourceId,
        reasonCode: "protected_action_failed",
      };
    }
    return {
      status: "success",
      requestId: execution.requestId,
      action: execution.action,
      resourceId: execution.resourceId,
      result: { summary: this.executionSummary(execution.resultSummary) },
    };
  }

  private executionSummary(value: unknown): string {
    return isRecord(value) && typeof value.summary === "string"
      ? value.summary
      : "Protected action completed";
  }

  private approvalDecisionsFor(approvalId: string | undefined): ApprovalDecision[] | null {
    if (!approvalId) return null;
    const approval = this.store.snapshot().approvals.find((candidate) => candidate.id === approvalId);
    return approval ? approval.approvalDecisions.map((decision) => ({ ...decision })) : null;
  }

  private async recordPolicyDecision(
    context: TrustedRuntimeContext,
    request: GatewayRequest,
    resource: ProtectedResource | null,
    decision: PolicyDecision,
    startedAt: number,
    grants: readonly AgentTeamGrant[] = [],
    memberships: readonly TeamMembership[] = [],
    riskAssessment?: RiskAssessment,
    reasonCodeOverride?: string,
  ): Promise<void> {
    const riskRequiresApproval =
      riskAssessment?.outcome === "allow" && riskAssessment.riskTier !== "low";
    const requiresApproval = decision.outcome === "require_approval" || riskRequiresApproval;
    const recordedOutcome: PolicyDecision["outcome"] = requiresApproval
      ? "require_approval"
      : decision.outcome;
    const recordedReasonCode =
      reasonCodeOverride ??
      (riskRequiresApproval
        ? riskAssessment.riskTier === "critical"
          ? "risk_requires_dual_control"
          : "risk_requires_owner_approval"
        : decision.reasonCode);
    const approvalEvidence =
      riskAssessment?.outcome === "allow" &&
      (requiresApproval)
        ? approvalRequirement(riskAssessment.riskTier)
        : null;
    await this.audit.record({
      eventType:
        recordedOutcome === "allow"
          ? "policy.allow"
          : recordedOutcome === "deny"
            ? "policy.deny"
            : "policy.approval_required",
      humanId: context.humanId,
      agentId: context.agentId,
      runId: context.runId,
      requestId: request.requestId,
      action: isRegisteredAction(request.action) ? request.action : null,
      resourceId: resource?.id ?? null,
      decision: auditDecisionFor(recordedOutcome),
      risk: riskAssessment?.outcome === "allow" ? riskAssessment.riskTier : decision.risk,
      reasonCode: recordedReasonCode,
      approvalId: null,
      capabilityId: null,
      status:
        recordedOutcome === "require_approval"
          ? "pending"
          : recordedOutcome === "deny"
            ? "failure"
            : "success",
      durationMs: Date.now() - startedAt,
      policyVersion: NAWGATE_POLICY_VERSION,
      explanation: explanationFor(context, request, resource, recordedReasonCode),
      enforcementPoint: "RuntimeGateway",
      protectedActionExecuted: false,
      riskVersion: riskAssessment?.riskVersion ?? null,
      riskFactsDigest: riskAssessment?.factsDigest ?? null,
      requiredApprovalCount: approvalEvidence?.count ?? null,
      requiredApprovalRoles: approvalEvidence?.roles ?? null,
      ...this.grantEvidence(
        resource,
        grants,
        memberships,
        recordedReasonCode === "restricted_file_requires_temporary_elevation",
      ),
    });
  }

  private grantEvidence(
    resource: ProtectedResource | null,
    grants: readonly AgentTeamGrant[],
    memberships: readonly TeamMembership[] = [],
    temporaryElevation = false,
  ): {
    grantId: string | null;
    teamId: TeamId | null;
    bundleVersion: number | null;
    effectiveScope: string[] | null;
    humanRole: TeamMembership["role"] | null;
    agentRole: AgentTeamGrant["role"] | null;
    resourceClassification: ProtectedResource["classification"] | null;
    temporaryScope: string[] | null;
  } {
    if (!resource || resource.type !== "team_file" || !isTeamId(resource.teamId)) {
      return {
        grantId: null,
        teamId: null,
        bundleVersion: null,
        effectiveScope: null,
        humanRole: null,
        agentRole: null,
        resourceClassification: null,
        temporaryScope: null,
      };
    }
    const grant = grants
      .filter((candidate) => candidate.teamId === resource.teamId)
      .sort((left, right) => right.bundleVersion - left.bundleVersion)[0];
    return {
      grantId: grant?.id ?? null,
      teamId: resource.teamId,
      bundleVersion: grant?.bundleVersion ?? null,
      effectiveScope: grant ? [...grant.allowedActions] : null,
      humanRole: memberships.find((membership) => membership.teamId === resource.teamId)?.role ?? null,
      agentRole: grant?.role ?? null,
      resourceClassification: resource.classification,
      temporaryScope: temporaryElevation ? ["file.read", resource.id] : null,
    };
  }

  private async serializeExecution<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.executionTail;
    let release!: () => void;
    this.executionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

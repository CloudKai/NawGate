import {
  ApprovalError,
  ApprovalService,
  type ApprovalRequest,
} from "./approval-service.js";
import { AuditService } from "./audit-service.js";
import { isHumanId } from "./demo-users.js";
import { TeamMembershipService, type MembershipResolver } from "./team-membership-service.js";
import type { JsonStore } from "../store.js";
import type {
  ActionExecutionRecord,
  AgentGateAction,
  AuditDecision,
  GatewayRequest,
  GatewayResult,
  PolicyEngine,
  PolicyDecision,
  ProtectedActionResult,
  ProtectedResource,
  TrustedRuntimeContext,
} from "./types.js";
import { AGENTGATE_POLICY_VERSION } from "./types.js";

interface ProtectedResourceBoundary {
  getMetadata(resourceId: string): ProtectedResource | null;
  execute(
    action: AgentGateAction,
    resourceId: string,
    execution?: { runId: string; requestId: string },
  ): Promise<ProtectedActionResult>;
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
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      key === "requestId" || key === "action" || key === "resourceId" || key === "approvalId",
    ) &&
    isNonEmptyString(value.requestId) &&
    isNonEmptyString(value.action) &&
    isNonEmptyString(value.resourceId) &&
    (value.approvalId === undefined || isNonEmptyString(value.approvalId))
  );
}

function isRegisteredAction(value: string): value is AgentGateAction {
  return (
    value === "resource.read" ||
    value === "file.read" ||
    value === "deploy.staging" ||
    value === "deploy.production"
  );
}

function environmentFor(action: string): "local" | "staging" | "production" {
  if (action === "deploy.staging") return "staging";
  if (action === "deploy.production") return "production";
  return "local";
}

function auditDecisionFor(outcome: PolicyDecision["outcome"]): AuditDecision {
  return outcome;
}

function riskFor(action: AgentGateAction): "low" | "medium" | "high" {
  if (action === "resource.read") return "low";
  return action === "deploy.production" ? "high" : "medium";
}

function explanationFor(
  context: TrustedRuntimeContext,
  request: GatewayRequest,
  resource: ProtectedResource | null,
  reasonCode: string,
): string {
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

  constructor(
    private readonly policy: PolicyEngine,
    private readonly resources: ProtectedResourceBoundary,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalService,
    private readonly store: JsonStore,
    private readonly memberships: MembershipResolver = new TeamMembershipService(store),
  ) {}

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
        policyVersion: AGENTGATE_POLICY_VERSION,
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
    const decision = await this.policy.evaluate({
      requestId: request.requestId,
      subject: {
        humanId: context.humanId,
        agentId: context.agentId,
        runId: context.runId,
        memberships,
      },
      object: { resource },
      action: { name: request.action },
      environment: { name: environmentFor(request.action) },
    });
    await this.recordPolicyDecision(context, request, resource, decision, startedAt);

    if (decision.outcome === "deny") {
      return {
        status: "denied",
        requestId: request.requestId,
        action: request.action,
        resourceId: request.resourceId,
        reasonCode: decision.reasonCode,
      };
    }

    return this.serializeExecution(async () => {
      const existing = this.findExecution(context.runId, request.requestId);
      if (existing) {
        if (
          existing.action !== request.action ||
          existing.resourceId !== request.resourceId
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

      if (decision.outcome === "require_approval") {
        const approvalRequest: ApprovalRequest = {
          humanId: context.humanId,
          agentId: context.agentId,
          runId: context.runId,
          requestId: request.requestId,
          action: request.action,
          resourceId: request.resourceId,
          reasonCode: decision.reasonCode,
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
              risk: decision.risk,
              reasonCode: decision.reasonCode,
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
            risk: decision.risk,
            reasonCode: decision.reasonCode,
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
            risk: decision.risk,
            reasonCode: consumption.reasonCode,
            approvalId: request.approvalId,
            capabilityId: null,
            status: "failure",
            durationMs: Date.now() - startedAt,
            policyVersion: AGENTGATE_POLICY_VERSION,
            explanation: explanationFor(context, request, resource, consumption.reasonCode),
            enforcementPoint: "RuntimeGateway",
            protectedActionExecuted: false,
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
      }

      return this.executeProtected(context, request, startedAt);
    });
  }

  private async executeProtected(
    context: TrustedRuntimeContext,
    request: GatewayRequest,
    startedAt: number,
  ): Promise<GatewayResult> {
    try {
      const result = await this.resources.execute(request.action, request.resourceId, {
        runId: context.runId,
        requestId: request.requestId,
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
        risk: riskFor(request.action),
        reasonCode: "protected_action_succeeded",
        approvalId: request.approvalId ?? null,
        capabilityId: null,
        status: "success",
        durationMs: Date.now() - startedAt,
        policyVersion: AGENTGATE_POLICY_VERSION,
        explanation: "The RuntimeGateway authorized and completed the protected action.",
        enforcementPoint: "RuntimeGateway",
        protectedActionExecuted: true,
      });
      return {
        status: "success",
        requestId: request.requestId,
        action: request.action,
        resourceId: request.resourceId,
        result,
      };
    } catch {
      await this.store.mutate((database) => {
        database.actionExecutions.push({
          runId: context.runId,
          requestId: request.requestId,
          action: request.action,
          resourceId: request.resourceId,
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
        risk: riskFor(request.action),
        reasonCode: "protected_action_failed",
        approvalId: request.approvalId ?? null,
        capabilityId: null,
        status: "failure",
        durationMs: Date.now() - startedAt,
        policyVersion: AGENTGATE_POLICY_VERSION,
        explanation: "Authorization passed, but the protected action failed during execution.",
        enforcementPoint: "RuntimeGateway",
        protectedActionExecuted: false,
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

  private findExecution(runId: string, requestId: string): ActionExecutionRecord | null {
    return (
      this.store
        .snapshot()
        .actionExecutions.find(
          (execution) => execution.runId === runId && execution.requestId === requestId,
        ) ?? null
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

  private async recordPolicyDecision(
    context: TrustedRuntimeContext,
    request: GatewayRequest,
    resource: ProtectedResource | null,
    decision: PolicyDecision,
    startedAt: number,
  ): Promise<void> {
    await this.audit.record({
      eventType:
        decision.outcome === "allow"
          ? "policy.allow"
          : decision.outcome === "deny"
            ? "policy.deny"
            : "policy.approval_required",
      humanId: context.humanId,
      agentId: context.agentId,
      runId: context.runId,
      requestId: request.requestId,
      action: isRegisteredAction(request.action) ? request.action : null,
      resourceId: resource?.id ?? null,
      decision: auditDecisionFor(decision.outcome),
      risk: decision.risk,
      reasonCode: decision.reasonCode,
      approvalId: null,
      capabilityId: null,
      status:
        decision.outcome === "require_approval"
          ? "pending"
          : decision.outcome === "deny"
            ? "failure"
            : "success",
      durationMs: Date.now() - startedAt,
      policyVersion: AGENTGATE_POLICY_VERSION,
      explanation: explanationFor(context, request, resource, decision.reasonCode),
      enforcementPoint: "RuntimeGateway",
      protectedActionExecuted: false,
    });
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

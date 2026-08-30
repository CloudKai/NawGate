import {
  ApprovalError,
  ApprovalService,
  type ApprovalRequest,
} from "./approval-service.js";
import { AuditService } from "./audit-service.js";
import { isHumanId } from "./demo-users.js";
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
    isNonEmptyString(value.requestId) &&
    isNonEmptyString(value.action) &&
    isNonEmptyString(value.resourceId) &&
    (value.approvalId === undefined || isNonEmptyString(value.approvalId))
  );
}

function isRegisteredAction(value: string): value is AgentGateAction {
  return (
    value === "resource.read" ||
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

export class RuntimeGateway {
  private executionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly policy: PolicyEngine,
    private readonly resources: ProtectedResourceBoundary,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalService,
    private readonly store: JsonStore,
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

    const decision = await this.policy.evaluate({
      humanId: context.humanId,
      agentId: context.agentId,
      runId: context.runId,
      requestId: request.requestId,
      action: request.action,
      resource,
      environment: environmentFor(request.action),
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

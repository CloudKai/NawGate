export type HumanId = "user-a" | "user-b";

export interface HumanPrincipal {
  id: HumanId;
  name: string;
}

export type AgentGateAction =
  | "resource.read"
  | "deploy.staging"
  | "deploy.production";

export type ProtectedResourceType = "project_profile" | "deployment_target";
export type ResourceClassification = "internal" | "sensitive";

export interface ProtectedResource {
  id: string;
  type: ProtectedResourceType;
  ownerUserId: HumanId;
  classification: ResourceClassification;
}

export type PolicyEnvironment = "local" | "staging" | "production";

export interface PolicyInput {
  humanId: HumanId;
  agentId: string;
  runId: string;
  requestId: string;
  action: AgentGateAction;
  resource: ProtectedResource;
  environment: PolicyEnvironment;
}

export type PolicyDenyReasonCode =
  | "resource_owner_mismatch"
  | "unknown_action"
  | "unknown_resource"
  | "invalid_context";

export type PolicyDecision =
  | {
      outcome: "allow";
      risk: "low" | "medium";
      reasonCode: "owned_resource_read" | "owned_staging_deploy";
    }
  | {
      outcome: "deny";
      risk: "low" | "medium" | "high";
      reasonCode: PolicyDenyReasonCode;
    }
  | {
      outcome: "require_approval";
      risk: "high";
      reasonCode: "production_deploy_requires_owner_approval";
    };

export interface PolicyEngine {
  evaluate(input: PolicyInput): Promise<PolicyDecision>;
}

export interface ProtectedActionResult {
  summary: string;
  content?: string;
}

export interface TrustedRuntimeContext {
  humanId: HumanId;
  agentId: string;
  runId: string;
}

export interface GatewayRequest {
  requestId: string;
  action: AgentGateAction;
  resourceId: string;
  approvalId?: string;
}

export type GatewayDenyReasonCode =
  | PolicyDenyReasonCode
  | "approval_denied"
  | "approval_expired"
  | "capability_consumed"
  | "invalid_capability";

export type GatewayResult =
  | {
      status: "success";
      requestId: string;
      action: AgentGateAction;
      resourceId: string;
      result: ProtectedActionResult;
    }
  | {
      status: "denied";
      requestId: string;
      action: string;
      resourceId: string;
      reasonCode: GatewayDenyReasonCode;
    }
  | {
      status: "approval_required";
      requestId: string;
      action: AgentGateAction;
      resourceId: string;
      approvalId: string;
      risk: "high";
      reasonCode: "production_deploy_requires_owner_approval";
    }
  | {
      status: "failed";
      requestId: string;
      action: AgentGateAction;
      resourceId: string;
      reasonCode: "protected_action_failed";
    }
  | {
      status: "conflict";
      requestId: string;
      action: AgentGateAction;
      resourceId: string;
      reasonCode: "idempotency_mismatch";
    };

export interface DeploymentState {
  resourceId: string;
  environment: "staging" | "production";
  deployedVersion: string | null;
  deploymentCount: number;
  updatedAt: string | null;
}

export interface ApprovalRecord {
  id: string;
  humanId: HumanId;
  agentId: string;
  runId: string;
  requestId: string;
  action: AgentGateAction;
  resourceId: string;
  risk: "high";
  reasonCode: string;
  status: "pending" | "approved" | "denied" | "expired" | "consumed";
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
}

export interface CapabilityLease {
  id: string;
  approvalId: string;
  humanId: HumanId;
  agentId: string;
  runId: string;
  action: AgentGateAction;
  resourceId: string;
  requestId: string;
  issuedAt: string;
  expiresAt: string;
  remainingUses: 1 | 0;
}

export type AuditEventType =
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "policy.allow"
  | "policy.deny"
  | "policy.approval_required"
  | "approval.approved"
  | "approval.denied"
  | "approval.expired"
  | "capability.issued"
  | "capability.consumed"
  | "protected_action.succeeded"
  | "protected_action.failed";

export type AuditDecision = "allow" | "deny" | "require_approval";
export type AuditRisk = "low" | "medium" | "high";
export type AuditStatus = "success" | "failure" | "pending";

export interface AuditEvent {
  id: string;
  eventType: AuditEventType;
  createdAt: string;
  humanId: HumanId | null;
  agentId: string | null;
  runId: string | null;
  requestId: string | null;
  action: AgentGateAction | null;
  resourceId: string | null;
  decision: AuditDecision | null;
  risk: AuditRisk | null;
  reasonCode: string | null;
  approvalId: string | null;
  capabilityId: string | null;
  status: AuditStatus;
  durationMs: number | null;
}

export interface ActionExecutionRecord {
  runId: string;
  requestId: string;
  action: AgentGateAction;
  resourceId: string;
  status: "succeeded" | "failed";
  resultSummary?: unknown;
  completedAt: string;
}

export type HumanId = "user-a" | "user-b";

export type TeamId = "team-alpha" | "team-beta";
export type TeamRole = "viewer" | "editor" | "admin";

// Zanzibar-style relationship tuple: a human has a role in a team.
export interface TeamMembership {
  teamId: TeamId;
  humanId: HumanId;
  role: TeamRole;
}

// Keep the policy contract visible in every meaningful decision trail. A
// version bump is required when the authorization semantics change.
export const AGENTGATE_POLICY_VERSION = "bouncer-v2";

export interface HumanPrincipal {
  id: HumanId;
  name: string;
}

export type AgentGateAction =
  | "resource.read"
  | "file.read"
  | "deploy.staging"
  | "deploy.production";

export type ResourceClassification = "internal" | "sensitive" | "restricted";

export interface ProjectProfileResource {
  id: string;
  type: "project_profile";
  ownerUserId: HumanId;
  classification: "sensitive" | "internal";
}

export interface DeploymentTargetResource {
  id: string;
  type: "deployment_target";
  ownerUserId: HumanId;
  classification: "sensitive" | "internal";
}

export interface TeamFileResource {
  id: string;
  type: "team_file";
  // Team files use relationship membership, not an individual owner.
  ownerUserId: null;
  teamId: TeamId | string;
  classification: "internal" | "restricted";
  minimumRole: TeamRole | string;
}

export type ProtectedResource =
  | ProjectProfileResource
  | DeploymentTargetResource
  | TeamFileResource;

export type PolicyEnvironment = "local" | "staging" | "production";

// NIST SP 800-162-style policy attributes. The RuntimeGateway resolves
// memberships from trusted server state before constructing this input.
export interface PolicySubjectAttributes {
  humanId: HumanId;
  agentId: string;
  runId: string;
  memberships: readonly TeamMembership[];
}

export interface PolicyObjectAttributes {
  resource: ProtectedResource;
}

export interface PolicyActionAttributes {
  name: string;
}

export interface PolicyEnvironmentAttributes {
  name: PolicyEnvironment;
}

export interface PolicyInput {
  requestId: string;
  subject: PolicySubjectAttributes;
  object: PolicyObjectAttributes;
  action: PolicyActionAttributes;
  environment: PolicyEnvironmentAttributes;
}

export type PolicyDenyReasonCode =
  | "resource_owner_mismatch"
  | "unknown_action"
  | "unknown_resource"
  | "invalid_context"
  | "malformed_attributes"
  | "unknown_team"
  | "team_membership_missing"
  | "team_role_insufficient"
  | "action_resource_mismatch";

export type PolicyDecision =
  | {
      outcome: "allow";
      risk: "low" | "medium";
      reasonCode: "owned_resource_read" | "owned_staging_deploy" | "team_file_read";
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
  | "capability_revoked"
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
  status: "pending" | "approved" | "denied" | "expired" | "consumed" | "revoked";
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
  | "approval.revoked"
  | "runtime_identity.issued"
  | "runtime_identity.revoked"
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
  policyVersion: string | null;
  explanation: string | null;
  enforcementPoint: string | null;
  protectedActionExecuted: boolean | null;
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

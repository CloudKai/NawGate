export type HumanId = "user-a" | "user-b";

export type TeamId = "team-alpha" | "team-beta";
export type TeamRole = "viewer" | "editor" | "admin";

// Zanzibar-style relationship tuple: a human has a role in a team.
export interface TeamMembership {
  teamId: TeamId;
  humanId: HumanId;
  role: TeamRole;
}

export type AgentTeamGrantStatus = "active" | "revoked";

// A persistent enrollment is deliberately narrower than a human membership.
// Phase 10 registers only the protected file.read action.
export interface AgentTeamGrant {
  id: string;
  agentId: string;
  teamId: TeamId;
  role: TeamRole;
  allowedActions: AgentGateAction[];
  status: AgentTeamGrantStatus;
  approvedBy: HumanId;
  expiresAt: string | null;
  bundleVersion: number;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

// Keep the policy contract visible in every meaningful decision trail. A
// version bump is required when the authorization semantics change.
export const AGENTGATE_POLICY_VERSION = "bouncer-v4";
export const AGENTGATE_POLICY_REVISION = AGENTGATE_POLICY_VERSION;

export interface HumanPrincipal {
  id: HumanId;
  name: string;
}

export type AgentGateAction =
  | "resource.read"
  | "file.read"
  | "deploy.staging"
  | "deploy.production"
  | ContentAction;

export type ResourceClassification = "internal" | "sensitive" | "restricted";

export type ContentPurpose =
  | "safety_moderation"
  | "creator_requested_publish"
  | "approved_analytics"
  | "compliance_archive";

export type ContentAction =
  | "content.moderate"
  | "content.disclose"
  | "content.publish"
  | "content.export";

export interface ContentActionBinding {
  purpose: ContentPurpose;
  organizationId: string;
  businessCenterId: string;
  accountId: string;
  assetId: string;
  contentVersion: string;
}

export interface ContentScopeGrant {
  id: string;
  humanId: HumanId;
  organizationId: string;
  businessCenterId: string;
  accountId: string;
  assetIds: string[];
  allowedActions: Extract<AgentGateAction, "content.disclose">[];
  allowedPurposes: Extract<ContentPurpose, "approved_analytics">[];
  destinations: string[];
}

export interface ProjectProfileResource {
  id: string;
  type: "project_profile";
  ownerUserId: HumanId;
  classification: "sensitive" | "internal";
  revision: number;
}

export interface DeploymentTargetResource {
  id: string;
  type: "deployment_target";
  ownerUserId: HumanId;
  classification: "sensitive" | "internal";
  revision: number;
}

export interface TeamFileResource {
  id: string;
  type: "team_file";
  // Team files use relationship membership, not an individual owner.
  ownerUserId: null;
  teamId: TeamId | string;
  classification: "internal" | "restricted";
  minimumRole: TeamRole | string;
  revision: number;
}

export interface ContentAssetResource {
  id: string;
  type: "content_asset";
  ownerUserId: HumanId;
  classification: "sensitive" | "restricted";
  revision: number;
  organizationId: string;
  businessCenterId: string;
  accountId: string;
  assetId: string;
  contentVersion: string;
}

export type ProtectedResource =
  | ProjectProfileResource
  | DeploymentTargetResource
  | TeamFileResource
  | ContentAssetResource;

export type PolicyEnvironment = "local" | "staging" | "production";

// NIST SP 800-162-style policy attributes. The RuntimeGateway resolves
// memberships from trusted server state before constructing this input.
export interface PolicySubjectAttributes {
  humanId: HumanId;
  agentId: string;
  runId: string;
  memberships: readonly TeamMembership[];
  agentGrants: readonly AgentTeamGrant[];
  contentScopes: readonly ContentScopeGrant[];
}

export interface PolicyObjectAttributes {
  resource: ProtectedResource;
}

export interface PolicyActionAttributes {
  name: string;
  contentBinding?: ContentActionBinding;
  destination?: string | null;
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
  | "agent_grant_missing"
  | "agent_grant_revoked"
  | "agent_grant_expired"
  | "agent_grant_action_under_scoped"
  | "agent_grant_role_insufficient"
  | "restricted_file_requires_temporary_elevation"
  | "runtime_authority_revoked"
  | "action_resource_mismatch"
  | "resource_revision_changed"
  | "content_purpose_mismatch"
  | "content_asset_mismatch"
  | "content_version_mismatch"
  | "content_scope_missing"
  | "content_destination_unknown"
  | "content_destination_mismatch";

export type PolicyDecision =
  | {
      outcome: "allow";
      risk: "low" | "medium";
      reasonCode:
        | "owned_resource_read"
        | "owned_staging_deploy"
        | "team_file_read"
        | "content_moderation_allowed"
        | "content_disclosure_allowed";
    }
  | {
      outcome: "deny";
      risk: "low" | "medium" | "high";
      reasonCode: PolicyDenyReasonCode;
    }
  | {
      outcome: "require_approval";
      risk: "high";
      reasonCode:
        | "production_deploy_requires_owner_approval"
        | "restricted_file_requires_temporary_elevation"
        | "content_publish_requires_owner_approval"
        | "content_export_requires_owner_approval";
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
  payload?: unknown;
  destination?: string | null;
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
      reasonCode:
        | "production_deploy_requires_owner_approval"
        | "restricted_file_requires_temporary_elevation"
        | "content_publish_requires_owner_approval"
        | "content_export_requires_owner_approval";
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
  payloadDigest: string | null;
  destination: string | null;
  policyRevision: string | null;
  resourceRevision: number | null;
  grantId?: string;
  teamId?: TeamId;
  bundleVersion?: number;
  effectiveScope?: string[];
  humanRole?: TeamRole;
  agentRole?: TeamRole;
  resourceClassification?: ResourceClassification;
  temporaryScope?: string[];
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
  payloadDigest: string;
  destination: string | null;
  policyRevision: string;
  resourceRevision: number;
  grantId?: string;
  teamId?: TeamId;
  bundleVersion?: number;
  effectiveScope?: string[];
  humanRole?: TeamRole;
  agentRole?: TeamRole;
  resourceClassification?: ResourceClassification;
  temporaryScope?: string[];
}

// This is the durable, non-secret claim material. It intentionally contains
// no bearer credential or protected payload; CapabilityLease is the safe
// result returned to the gateway after an atomic store transition.
export type CapabilityClaim = CapabilityLease;

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
  | "runtime.request_rejected"
  | "lab_run.started"
  | "lab_run.completed"
  | "lab_run.cancelled"
  | "capability.issued"
  | "capability.consumed"
  | "protected_action.succeeded"
  | "protected_action.failed"
  | "agent_grant.enrolled"
  | "agent_grant.revoked";

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
  grantId: string | null;
  teamId: TeamId | null;
  bundleVersion: number | null;
  effectiveScope: string[] | null;
  humanRole: TeamRole | null;
  agentRole: TeamRole | null;
  resourceClassification: ResourceClassification | null;
  temporaryScope: string[] | null;
  rejectedFieldNames: string[] | null;
}

export interface ActionExecutionRecord {
  runId: string;
  requestId: string;
  action: AgentGateAction;
  resourceId: string;
  payloadDigest: string | null;
  destination: string | null;
  policyRevision: string | null;
  resourceRevision: number | null;
  status: "succeeded" | "failed";
  resultSummary?: unknown;
  completedAt: string;
}

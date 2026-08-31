import {
  isContentAction,
  isContentPurpose,
} from "./content-model.js";
import { isRegisteredDestination, isRegisteredDestinationId } from "./destination-catalogue.js";
import { isHumanId, isTeamId, isTeamRole } from "./demo-users.js";
import type {
  AgentGateAction,
  ContentActionBinding,
  ContentScopeGrant,
  PolicyDecision,
  PolicyEngine,
  PolicyEnvironment,
  PolicyInput,
  ProtectedResource,
  TeamRole,
  AgentTeamGrant,
} from "./types.js";

const actions: readonly AgentGateAction[] = [
  "resource.read",
  "file.read",
  "deploy.staging",
  "deploy.production",
  "content.moderate",
  "content.disclose",
  "content.publish",
  "content.export",
];
const grantActions = ["resource.read", "file.read", "deploy.staging", "deploy.production"] as const;

const environments: readonly PolicyEnvironment[] = ["local", "staging", "production"];

function isKnownAction(value: unknown): value is AgentGateAction {
  return typeof value === "string" && actions.includes(value as AgentGateAction);
}

function isKnownEnvironment(value: unknown): value is PolicyEnvironment {
  return typeof value === "string" && environments.includes(value as PolicyEnvironment);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidMembership(value: unknown, humanId: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.teamId === "string" &&
    isTeamId(value.teamId) &&
    typeof value.humanId === "string" &&
    value.humanId === humanId &&
    isHumanId(value.humanId) &&
    typeof value.role === "string" &&
    isTeamRole(value.role)
  );
}

function isValidContentBinding(value: unknown): value is ContentActionBinding {
  return (
    isRecord(value) &&
    isContentPurpose(value.purpose) &&
    isNonEmptyString(value.organizationId) &&
    isNonEmptyString(value.businessCenterId) &&
    isNonEmptyString(value.accountId) &&
    isNonEmptyString(value.assetId) &&
    isNonEmptyString(value.contentVersion)
  );
}

function isValidContentScope(value: unknown, humanId: string): value is ContentScopeGrant {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    value.humanId === humanId &&
    isHumanId(value.humanId) &&
    isNonEmptyString(value.organizationId) &&
    isNonEmptyString(value.businessCenterId) &&
    isNonEmptyString(value.accountId) &&
    Array.isArray(value.assetIds) &&
    value.assetIds.length > 0 &&
    value.assetIds.every(isNonEmptyString) &&
    Array.isArray(value.allowedActions) &&
    value.allowedActions.length > 0 &&
    value.allowedActions.every((action) => action === "content.disclose") &&
    Array.isArray(value.allowedPurposes) &&
    value.allowedPurposes.length > 0 &&
    value.allowedPurposes.every((purpose) => purpose === "approved_analytics") &&
    Array.isArray(value.destinations) &&
    value.destinations.length > 0 &&
    value.destinations.every((destination) => isRegisteredDestinationId(destination))
  );
}

function isValidResourceShape(value: unknown): value is ProtectedResource {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    typeof value.type !== "string" ||
    typeof value.revision !== "number" ||
    !Number.isInteger(value.revision) ||
    value.revision <= 0
  ) {
    return false;
  }
  if (value.type === "team_file") {
    return (
      value.ownerUserId === null &&
      typeof value.teamId === "string" &&
      value.teamId.length > 0 &&
      (value.classification === "internal" || value.classification === "restricted") &&
      typeof value.minimumRole === "string" &&
      isTeamRole(value.minimumRole)
    );
  }
  if (value.type === "content_asset") {
    return (
      typeof value.ownerUserId === "string" &&
      isHumanId(value.ownerUserId) &&
      (value.classification === "sensitive" || value.classification === "restricted") &&
      isNonEmptyString(value.organizationId) &&
      isNonEmptyString(value.businessCenterId) &&
      isNonEmptyString(value.accountId) &&
      isNonEmptyString(value.assetId) &&
      isNonEmptyString(value.contentVersion)
    );
  }
  return (
    (value.type === "project_profile" || value.type === "deployment_target") &&
    typeof value.ownerUserId === "string" &&
    isHumanId(value.ownerUserId) &&
    (value.classification === "internal" || value.classification === "sensitive")
  );
}

function isValidGrantShape(value: unknown, agentId: string): value is AgentTeamGrant {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    typeof value.agentId === "string" &&
    value.agentId === agentId &&
    typeof value.teamId === "string" &&
    isTeamId(value.teamId) &&
    typeof value.role === "string" &&
    isTeamRole(value.role) &&
    Array.isArray(value.allowedActions) &&
    value.allowedActions.every((action) =>
      typeof action === "string" && grantActions.includes(action as (typeof grantActions)[number]),
    ) &&
    (value.status === "active" || value.status === "revoked") &&
    typeof value.approvedBy === "string" && isHumanId(value.approvedBy) &&
    (value.expiresAt === null ||
      (typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt)))) &&
    typeof value.bundleVersion === "number" &&
    Number.isInteger(value.bundleVersion) &&
    value.bundleVersion > 0 &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    ((value.status === "active" && value.revokedAt === null) ||
      (value.status === "revoked" &&
        typeof value.revokedAt === "string" &&
        Number.isFinite(Date.parse(value.revokedAt))))
  );
}

function isValidAttributeShape(input: unknown): input is PolicyInput {
  if (!isRecord(input)) return false;
  if (!isNonEmptyString(input.requestId)) return false;
  const subject = input.subject;
  const object = input.object;
  const action = input.action;
  const environment = input.environment;
  if (!isRecord(subject) || !isRecord(object) || !isRecord(action)) {
    return false;
  }
  if (!isRecord(environment)) return false;
  if (
    typeof subject.humanId !== "string" ||
    !isHumanId(subject.humanId) ||
    !isNonEmptyString(subject.agentId) ||
    !isNonEmptyString(subject.runId)
  ) {
    return false;
  }
  const agentId = subject.agentId;
  if (
    !Array.isArray(subject.memberships) ||
    !subject.memberships.every((membership) =>
      isValidMembership(membership, subject.humanId),
    ) ||
    !Array.isArray(subject.agentGrants) ||
    !subject.agentGrants.every((grant) => isValidGrantShape(grant, agentId)) ||
    !Array.isArray(subject.contentScopes) ||
    !subject.contentScopes.every((scope) => isValidContentScope(scope, subject.humanId as string)) ||
    !isValidResourceShape(object.resource) ||
    !isNonEmptyString(action.name) ||
    (action.contentBinding !== undefined && !isValidContentBinding(action.contentBinding)) ||
    (action.destination !== undefined &&
      action.destination !== null &&
      !isNonEmptyString(action.destination)) ||
    (action.registeredDestination !== undefined &&
      action.registeredDestination !== null &&
      !isRegisteredDestination(action.registeredDestination)) ||
    !isKnownEnvironment(environment.name)
  ) {
    return false;
  }
  if (isContentAction(action.name) && action.contentBinding === undefined) return false;
  return true;
}

function roleRank(role: TeamRole): number {
  return role === "admin" ? 3 : role === "editor" ? 2 : 1;
}

function teamFileDecision(input: PolicyInput, now: number): PolicyDecision {
  const resource = input.object.resource;
  if (resource.type !== "team_file" || input.action.name !== "file.read") {
    return {
      outcome: "deny",
      risk: "medium",
      reasonCode: "action_resource_mismatch",
    };
  }
  if (input.environment.name !== "local") {
    return {
      outcome: "deny",
      risk: "medium",
      reasonCode: "action_resource_mismatch",
    };
  }
  if (!isTeamId(resource.teamId)) {
    return {
      outcome: "deny",
      risk: "high",
      reasonCode: "unknown_team",
    };
  }
  if (!isTeamRole(resource.minimumRole)) {
    return {
      outcome: "deny",
      risk: "high",
      reasonCode: "malformed_attributes",
    };
  }
  const membership = input.subject.memberships.find(
    (candidate) => candidate.teamId === resource.teamId,
  );
  if (!membership) {
    return {
      outcome: "deny",
      risk: "high",
      reasonCode: "team_membership_missing",
    };
  }
  const minimumHumanRole = resource.minimumRole;
  if (roleRank(membership.role) < roleRank(minimumHumanRole)) {
    return {
      outcome: "deny",
      risk: "high",
      reasonCode: "team_role_insufficient",
    };
  }
  const grants = input.subject.agentGrants.filter(
    (grant) => grant.teamId === resource.teamId,
  );
  if (grants.length === 0) {
    return {
      outcome: "deny",
      risk: "high",
      reasonCode: "agent_grant_missing",
    };
  }
  const activeGrant = grants.find((grant) => grant.status === "active");
  if (!activeGrant) {
    return {
      outcome: "deny",
      risk: "high",
      reasonCode: "agent_grant_revoked",
    };
  }
  if (
    activeGrant.expiresAt !== null &&
    Date.parse(activeGrant.expiresAt) <= now
  ) {
    return {
      outcome: "deny",
      risk: "high",
      reasonCode: "agent_grant_expired",
    };
  }
  if (!activeGrant.allowedActions.includes("file.read")) {
    return {
      outcome: "deny",
      risk: "high",
      reasonCode: "agent_grant_action_under_scoped",
    };
  }
  const restrictedMinimumRole =
    resource.classification === "restricted" && roleRank(resource.minimumRole) < roleRank("editor")
      ? "editor"
      : resource.minimumRole;
  if (roleRank(activeGrant.role) < roleRank(restrictedMinimumRole)) {
    if (resource.classification === "restricted") {
      return {
        outcome: "require_approval",
        risk: "high",
        reasonCode: "restricted_file_requires_temporary_elevation",
      };
    }
    return {
      outcome: "deny",
      risk: "high",
      reasonCode: "agent_grant_role_insufficient",
    };
  }
  return {
    outcome: "allow",
    risk: "low",
    reasonCode: "team_file_read",
  };
}

function contentDecision(input: PolicyInput): PolicyDecision {
  const resource = input.object.resource;
  if (resource.type !== "content_asset") {
    return { outcome: "deny", risk: "high", reasonCode: "action_resource_mismatch" };
  }
  if (input.environment.name !== "local") {
    return { outcome: "deny", risk: "high", reasonCode: "action_resource_mismatch" };
  }
  if (input.subject.humanId !== resource.ownerUserId) {
    return { outcome: "deny", risk: "high", reasonCode: "resource_owner_mismatch" };
  }
  const binding = input.action.contentBinding;
  if (!binding) {
    return { outcome: "deny", risk: "high", reasonCode: "malformed_attributes" };
  }
  if (
    binding.organizationId !== resource.organizationId ||
    binding.businessCenterId !== resource.businessCenterId ||
    binding.accountId !== resource.accountId ||
    binding.assetId !== resource.assetId
  ) {
    return { outcome: "deny", risk: "high", reasonCode: "content_asset_mismatch" };
  }
  if (binding.contentVersion !== resource.contentVersion) {
    return { outcome: "deny", risk: "high", reasonCode: "content_version_mismatch" };
  }

  const action = input.action.name as AgentGateAction;
  const destination = input.action.destination ?? null;
  const expectedPurpose =
    action === "content.moderate"
      ? "safety_moderation"
      : action === "content.publish"
        ? "creator_requested_publish"
        : action === "content.disclose"
          ? "approved_analytics"
          : "compliance_archive";
  if (binding.purpose !== expectedPurpose) {
    return { outcome: "deny", risk: "high", reasonCode: "content_purpose_mismatch" };
  }

  if (action === "content.moderate") {
    if (destination !== null) {
      return {
        outcome: "deny",
        risk: "high",
        reasonCode: input.action.registeredDestination
          ? "content_destination_mismatch"
          : "content_destination_unknown",
      };
    }
    return { outcome: "allow", risk: "low", reasonCode: "content_moderation_allowed" };
  }

  if (typeof destination !== "string") {
    return { outcome: "deny", risk: "high", reasonCode: "content_destination_unknown" };
  }
  const registeredDestination = input.action.registeredDestination;
  if (!registeredDestination || registeredDestination.id !== destination) {
    return { outcome: "deny", risk: "high", reasonCode: "content_destination_unknown" };
  }
  if (registeredDestination.status === "disabled") {
    return { outcome: "deny", risk: "high", reasonCode: "content_destination_disabled" };
  }
  if (registeredDestination.status === "revoked") {
    return { outcome: "deny", risk: "high", reasonCode: "content_destination_revoked" };
  }
  if (!registeredDestination.allowedActions.includes(action as "content.disclose" | "content.publish" | "content.export")) {
    return { outcome: "deny", risk: "high", reasonCode: "content_destination_action_mismatch" };
  }
  if (!registeredDestination.purposes.includes(binding.purpose)) {
    return { outcome: "deny", risk: "high", reasonCode: "content_destination_purpose_mismatch" };
  }
  const expectedClassification = action === "content.disclose" ? "sensitive" : "restricted";
  if (registeredDestination.classification !== expectedClassification) {
    return { outcome: "deny", risk: "high", reasonCode: "content_destination_classification_mismatch" };
  }
  if (registeredDestination.environment !== input.environment.name) {
    return { outcome: "deny", risk: "high", reasonCode: "content_destination_environment_mismatch" };
  }
  if (
    registeredDestination.organizationId !== resource.organizationId ||
    registeredDestination.businessCenterId !== resource.businessCenterId ||
    registeredDestination.accountId !== resource.accountId
  ) {
    return { outcome: "deny", risk: "high", reasonCode: "content_destination_tenant_mismatch" };
  }

  if (action === "content.disclose") {
    const scope = input.subject.contentScopes.find(
      (candidate) =>
        candidate.humanId === input.subject.humanId &&
        candidate.organizationId === resource.organizationId &&
        candidate.businessCenterId === resource.businessCenterId &&
        candidate.accountId === resource.accountId &&
        candidate.assetIds.includes(resource.assetId) &&
        candidate.allowedActions.includes("content.disclose") &&
        candidate.allowedPurposes.includes("approved_analytics") &&
        candidate.destinations.includes(destination),
    );
    if (!scope) {
      return { outcome: "deny", risk: "high", reasonCode: "content_scope_missing" };
    }
    return { outcome: "allow", risk: "medium", reasonCode: "content_disclosure_allowed" };
  }

  return {
    outcome: "require_approval",
    risk: "high",
    reasonCode:
      action === "content.publish"
        ? "content_publish_requires_owner_approval"
        : "content_export_requires_owner_approval",
  };
}

export class DeterministicPolicyEngine implements PolicyEngine {
  constructor(private readonly now: () => number = Date.now) {}

  async evaluate(input: PolicyInput): Promise<PolicyDecision> {
    if (!isRecord(input)) {
      return { outcome: "deny", risk: "high", reasonCode: "invalid_context" };
    }
    if (!isValidAttributeShape(input)) {
      return { outcome: "deny", risk: "high", reasonCode: "malformed_attributes" };
    }

    // Unknown action is denied before any resource-side effect or approval.
    if (!isKnownAction(input.action.name)) {
      return { outcome: "deny", risk: "low", reasonCode: "unknown_action" };
    }

    if (
      input.subject.memberships.some((membership) => !isTeamId(membership.teamId)) ||
      (input.object.resource.type === "team_file" &&
        !isTeamId(input.object.resource.teamId))
    ) {
      return { outcome: "deny", risk: "high", reasonCode: "unknown_team" };
    }

    if (input.object.resource.type === "team_file") {
      return teamFileDecision(input, this.now());
    }

    if (isContentAction(input.action.name)) {
      return contentDecision(input);
    }

    // Existing user-owned resources retain their hard cross-user boundary.
    if (input.subject.humanId !== input.object.resource.ownerUserId) {
      return {
        outcome: "deny",
        risk: "high",
        reasonCode: "resource_owner_mismatch",
      };
    }

    if (
      input.action.name === "resource.read" &&
      input.object.resource.type === "project_profile" &&
      input.environment.name === "local"
    ) {
      return {
        outcome: "allow",
        risk: "low",
        reasonCode: "owned_resource_read",
      };
    }

    if (
      input.action.name === "deploy.staging" &&
      input.object.resource.type === "deployment_target" &&
      input.environment.name === "staging"
    ) {
      return {
        outcome: "allow",
        risk: "medium",
        reasonCode: "owned_staging_deploy",
      };
    }

    if (
      input.action.name === "deploy.production" &&
      input.object.resource.type === "deployment_target" &&
      input.environment.name === "production"
    ) {
      return {
        outcome: "require_approval",
        risk: "high",
        reasonCode: "production_deploy_requires_owner_approval",
      };
    }

    return {
      outcome: "deny",
      risk: "medium",
      reasonCode: "action_resource_mismatch",
    };
  }
}

import { isHumanId, isTeamId, isTeamRole } from "./demo-users.js";
import type {
  AgentGateAction,
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
];

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

function isValidResourceShape(value: unknown): value is ProtectedResource {
  if (!isRecord(value) || !isNonEmptyString(value.id) || typeof value.type !== "string") {
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
    value.allowedActions.every(isKnownAction) &&
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
    !isValidResourceShape(object.resource) ||
    !isNonEmptyString(action.name) ||
    !isKnownEnvironment(environment.name)
  ) {
    return false;
  }
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
  const requiredRole =
    resource.classification === "restricted" && roleRank(resource.minimumRole) < roleRank("editor")
      ? "editor"
      : resource.minimumRole;
  if (roleRank(membership.role) < roleRank(requiredRole)) {
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
  if (roleRank(activeGrant.role) < roleRank(requiredRole)) {
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

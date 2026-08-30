import { isHumanId } from "./demo-users.js";
import type {
  AgentGateAction,
  PolicyDecision,
  PolicyEngine,
  PolicyEnvironment,
  PolicyInput,
} from "./types.js";

const actions: readonly AgentGateAction[] = [
  "resource.read",
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

function isValidInput(input: unknown): input is PolicyInput {
  if (!isRecord(input) || !isRecord(input.resource)) return false;
  return (
    typeof input.humanId === "string" &&
    isHumanId(input.humanId) &&
    typeof input.agentId === "string" &&
    input.agentId.length > 0 &&
    typeof input.runId === "string" &&
    input.runId.length > 0 &&
    typeof input.requestId === "string" &&
    input.requestId.length > 0 &&
    typeof input.resource.id === "string" &&
    input.resource.id.length > 0 &&
    (input.resource.type === "project_profile" ||
      input.resource.type === "deployment_target") &&
    typeof input.resource.ownerUserId === "string" &&
    isHumanId(input.resource.ownerUserId) &&
    (input.resource.classification === "internal" ||
      input.resource.classification === "sensitive") &&
    isKnownEnvironment(input.environment)
  );
}

export class DeterministicPolicyEngine implements PolicyEngine {
  async evaluate(input: PolicyInput): Promise<PolicyDecision> {
    if (!isValidInput(input)) {
      return {
        outcome: "deny",
        risk: "high",
        reasonCode: "invalid_context",
      };
    }

    // Ownership mismatch is a hard deny and must happen before any approval logic.
    if (input.humanId !== input.resource.ownerUserId) {
      return {
        outcome: "deny",
        risk: "high",
        reasonCode: "resource_owner_mismatch",
      };
    }

    if (!isKnownAction(input.action)) {
      return {
        outcome: "deny",
        risk: "low",
        reasonCode: "unknown_action",
      };
    }

    if (
      input.action === "resource.read" &&
      input.resource.type === "project_profile" &&
      input.environment === "local"
    ) {
      return {
        outcome: "allow",
        risk: "low",
        reasonCode: "owned_resource_read",
      };
    }

    if (
      input.action === "deploy.staging" &&
      input.resource.type === "deployment_target" &&
      input.environment === "staging"
    ) {
      return {
        outcome: "allow",
        risk: "medium",
        reasonCode: "owned_staging_deploy",
      };
    }

    if (
      input.action === "deploy.production" &&
      input.resource.type === "deployment_target" &&
      input.environment === "production"
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
      reasonCode: "unknown_resource",
    };
  }
}

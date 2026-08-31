import { HttpError } from "../errors.js";
import type { JsonStore } from "../store.js";
import type { AuditService } from "./audit-service.js";
import { isHumanId } from "./demo-users.js";
import { AGENTGATE_POLICY_VERSION } from "./types.js";
import type {
  AgentGateAction,
  ApprovalAuthority,
  ApprovalAuthorityRole,
  HumanId,
  RiskTier,
} from "./types.js";

export interface ApprovalAuthorityEligibilityRequest {
  humanId: HumanId;
  organizationId?: string | null;
  accountId?: string | null;
  action: AgentGateAction;
  riskTier: RiskTier;
  role?: ApprovalAuthorityRole;
}

function scopeMatches(authority: ApprovalAuthority, request: ApprovalAuthorityEligibilityRequest): boolean {
  return (
    (request.organizationId === undefined || request.organizationId === null || authority.organizationId === request.organizationId) &&
    (authority.accountId === null || request.accountId === undefined || authority.accountId === request.accountId)
  );
}

export function isApprovalAuthorityEligible(
  authority: ApprovalAuthority,
  request: ApprovalAuthorityEligibilityRequest,
): boolean {
  return (
    authority.status === "active" &&
    authority.humanId === request.humanId &&
    (request.role === undefined || authority.role === request.role) &&
    authority.allowedActions.includes(request.action) &&
    authority.allowedRiskTiers.includes(request.riskTier) &&
    scopeMatches(authority, request) &&
    Number.isInteger(authority.revision) && authority.revision > 0
  );
}

export function eligibleApprovalAuthorities(
  authorities: readonly ApprovalAuthority[],
  request: ApprovalAuthorityEligibilityRequest,
): ApprovalAuthority[] {
  return authorities
    .filter((authority) => isApprovalAuthorityEligible(authority, request))
    .map((authority) => structuredClone(authority));
}

export class ApprovalAuthorityService {
  constructor(
    private readonly store: JsonStore,
    private readonly claims?: { revokeForAuthority(authorityId: string, reasonCode?: string): Promise<unknown> },
    private readonly audit?: AuditService,
  ) {}

  list(): ApprovalAuthority[] {
    return this.store.snapshot().approvalAuthorities.map((authority) => structuredClone(authority));
  }

  get(authorityId: string): ApprovalAuthority | null {
    const authority = this.store.snapshot().approvalAuthorities.find((candidate) => candidate.id === authorityId);
    return authority ? structuredClone(authority) : null;
  }

  listForHuman(humanId: HumanId): ApprovalAuthority[] {
    return this.list().filter((authority) => authority.humanId === humanId);
  }

  resolveEligible(request: ApprovalAuthorityEligibilityRequest): ApprovalAuthority[] {
    return eligibleApprovalAuthorities(this.store.snapshot().approvalAuthorities, request);
  }

  async revoke(authorityId: string, reason = "approval_authority_revoked"): Promise<ApprovalAuthority> {
    const authority = await this.store.mutate((database) => {
      const authority = database.approvalAuthorities.find((candidate) => candidate.id === authorityId);
      if (!authority) throw new HttpError(404, "Approval authority not found", "APPROVAL_AUTHORITY_NOT_FOUND");
      if (authority.status === "active") {
        const timestamp = new Date().toISOString();
        authority.status = "revoked";
        authority.revision += 1;
        authority.updatedAt = timestamp;
        authority.revokedAt = timestamp;
        authority.revocationReason = reason;
      }
      return structuredClone(authority);
    });
    await this.claims?.revokeForAuthority(authorityId, reason);
    if (authority.status === "revoked") {
      await this.audit?.record({
        eventType: "approval.revoked",
        humanId: authority.humanId,
        agentId: null,
        runId: null,
        requestId: null,
        action: null,
        resourceId: null,
        decision: "deny",
        risk: null,
        reasonCode: reason,
        approvalId: null,
        capabilityId: null,
        status: "failure",
        durationMs: null,
        policyVersion: AGENTGATE_POLICY_VERSION,
        explanation: "An approval authority was revoked; pending and approved capabilities using it were invalidated.",
        enforcementPoint: "ApprovalAuthorityService",
        protectedActionExecuted: false,
      });
    }
    return authority;
  }

  static isWellFormed(value: unknown): value is ApprovalAuthority {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const actions = new Set([
      "resource.read", "file.read", "deploy.staging", "deploy.production",
      "content.moderate", "content.disclose", "content.publish", "content.export",
    ]);
    const tiers = new Set(["low", "medium", "high", "critical"]);
    const keys = [
      "id", "humanId", "organizationId", "accountId", "allowedActions", "allowedRiskTiers",
      "role", "status", "revision", "createdAt", "updatedAt", "revokedAt", "revocationReason",
    ].sort();
    if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(keys)) return false;
    return (
      typeof record.id === "string" && record.id.length > 0 &&
      typeof record.humanId === "string" && isHumanId(record.humanId) &&
      typeof record.organizationId === "string" && record.organizationId.length > 0 &&
      (record.accountId === null || (typeof record.accountId === "string" && record.accountId.length > 0)) &&
      Array.isArray(record.allowedActions) && record.allowedActions.length > 0 &&
      new Set(record.allowedActions).size === record.allowedActions.length &&
      record.allowedActions.every((action) => typeof action === "string" && actions.has(action)) &&
      Array.isArray(record.allowedRiskTiers) && record.allowedRiskTiers.length > 0 &&
      new Set(record.allowedRiskTiers).size === record.allowedRiskTiers.length &&
      record.allowedRiskTiers.every((tier) => typeof tier === "string" && tiers.has(tier)) &&
      (record.role === "owner" || record.role === "independent_reviewer") &&
      (record.status === "active" || record.status === "revoked") &&
      typeof record.revision === "number" && Number.isInteger(record.revision) && record.revision > 0 &&
      typeof record.createdAt === "string" && Number.isFinite(Date.parse(record.createdAt)) &&
      typeof record.updatedAt === "string" && Number.isFinite(Date.parse(record.updatedAt)) &&
      (record.revokedAt === null || (typeof record.revokedAt === "string" && Number.isFinite(Date.parse(record.revokedAt)))) &&
      (record.revocationReason === null || typeof record.revocationReason === "string") &&
      ((record.status === "active" && record.revokedAt === null && record.revocationReason === null) ||
        (record.status === "revoked" && record.revokedAt !== null))
    );
  }
}

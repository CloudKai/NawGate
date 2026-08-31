import { randomUUID } from "node:crypto";
import { AuditService } from "./audit-service.js";
import { isApprovalAuthorityEligible } from "./approval-authority-service.js";
import { canonicalPayloadDigest } from "./canonical-json.js";
import {
  AGENTGATE_POLICY_REVISION,
  AGENTGATE_POLICY_VERSION,
  AGENTGATE_RISK_VERSION,
  type ApprovalRecord,
  type ApprovalDecision,
  type ApprovalAuthority,
  type ApprovalAuthorityRole,
  type AgentGateAction,
  type CapabilityClaim,
  type CapabilityLease,
  type HumanId,
  type ResourceClassification,
  type TeamId,
  type TeamRole,
  type RiskTier,
} from "./types.js";
import { isRegisteredDestinationId } from "./destination-catalogue.js";
import { JsonStore } from "../store.js";

const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1_000;

export interface ApprovalRequest {
  humanId: HumanId;
  agentId: string;
  runId: string;
  requestId: string;
  action: AgentGateAction;
  resourceId: string;
  reasonCode: string;
  // `payload` is accepted only to calculate a digest. It is never persisted
  // or passed to the audit service.
  payload?: unknown;
  payloadDigest?: string;
  destination?: string | null;
  policyRevision?: string | null;
  resourceRevision?: number | null;
  destinationRevision?: number | null;
  grantId?: string | null;
  teamId?: TeamId | null;
  bundleVersion?: number | null;
  effectiveScope?: string[] | null;
  humanRole?: TeamRole | null;
  agentRole?: TeamRole | null;
  resourceClassification?: ResourceClassification | null;
  temporaryScope?: string[] | null;
  requesterHumanId?: HumanId;
  risk?: RiskTier;
  riskVersion?: string;
  riskFactsDigest?: string;
  requiredApprovalCount?: number;
  requiredApprovalRoles?: ApprovalAuthorityRole[];
  organizationId?: string | null;
  accountId?: string | null;
}

export type CapabilityConsumption =
  | { status: "consumed"; capability: CapabilityLease }
  | { status: "pending"; approval: ApprovalRecord }
  | {
      status: "denied";
      reasonCode:
        | "approval_denied"
        | "approval_expired"
        | "capability_consumed"
        | "capability_revoked"
        | "approval_authority_revoked"
        | "invalid_capability";
    };

export type ApprovalErrorCode =
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_NOT_OWNED"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_DENIED"
  | "APPROVAL_REVOKED"
  | "APPROVAL_ALREADY_DECIDED"
  | "APPROVAL_INVALID"
  | "IDEMPOTENCY_MISMATCH";

export class ApprovalError extends Error {
  constructor(
    public readonly code: ApprovalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

interface NormalizedBinding {
  payloadDigest: string;
  destination: string | null;
  policyRevision: string;
  resourceRevision: number;
  destinationRevision: number | null;
  risk: RiskTier;
  riskVersion: string;
  riskFactsDigest: string;
  requiredApprovalCount: number;
  requiredApprovalRoles: ApprovalAuthorityRole[];
  requesterHumanId: HumanId;
  organizationId: string;
  accountId: string | null;
}

function isValidApprovalRequirement(
  risk: RiskTier,
  count: number,
  roles: readonly ApprovalAuthorityRole[],
): boolean {
  if (risk === "critical") {
    return count === 2 &&
      roles.length === 2 &&
      roles[0] === "owner" &&
      roles[1] === "independent_reviewer";
  }
  return count === 1 && roles.length === 1 && roles[0] === "owner";
}

function arrayEquals(left: readonly string[] | null | undefined, right: readonly string[] | null | undefined): boolean {
  if ((left ?? null) === null || (right ?? null) === null) {
    return (left ?? null) === (right ?? null);
  }
  return left!.length === right!.length && left!.every((value, index) => value === right![index]);
}

function normalizeBinding(request: ApprovalRequest): NormalizedBinding | null {
  let computedDigest: string;
  try {
    computedDigest = canonicalPayloadDigest(request.payload);
  } catch {
    return null;
  }
  if (request.payloadDigest !== undefined && request.payloadDigest !== computedDigest) return null;
  const destination = request.destination ?? null;
  if (destination !== null && (typeof destination !== "string" || destination.length === 0)) return null;
  const policyRevision = request.policyRevision ?? AGENTGATE_POLICY_REVISION;
  if (typeof policyRevision !== "string" || policyRevision.length === 0) return null;
  const resourceRevision = request.resourceRevision ?? 1;
  if (!Number.isInteger(resourceRevision) || resourceRevision <= 0) return null;
  const destinationRevision = request.destinationRevision ?? null;
  if (
    destinationRevision !== null &&
    (!Number.isInteger(destinationRevision) || destinationRevision <= 0)
  ) return null;
  const destinationRequired =
    request.action === "content.disclose" ||
    request.action === "content.publish" ||
    request.action === "content.export";
  if (
    destinationRequired &&
    (!isRegisteredDestinationId(destination) || destinationRevision === null)
  ) return null;
  if (request.action === "content.moderate" && (destination !== null || destinationRevision !== null)) {
    return null;
  }
  const risk = request.risk ?? "high";
  if (risk !== "low" && risk !== "medium" && risk !== "high" && risk !== "critical") return null;
  const riskVersion = request.riskVersion ?? AGENTGATE_RISK_VERSION;
  if (typeof riskVersion !== "string" || riskVersion.length === 0) return null;
  const riskFactsDigest = request.riskFactsDigest ?? canonicalPayloadDigest({
    action: request.action,
    resourceId: request.resourceId,
    destination,
    resourceRevision,
    destinationRevision,
    policyRevision,
    risk,
  });
  if (!/^[0-9a-f]{64}$/.test(riskFactsDigest)) return null;
  const requiredApprovalCount = request.requiredApprovalCount ?? (risk === "critical" ? 2 : 1);
  const requiredApprovalRoles = request.requiredApprovalRoles
    ? [...request.requiredApprovalRoles]
    : risk === "critical"
      ? ["owner", "independent_reviewer"]
      : ["owner"];
  if (
    !Number.isInteger(requiredApprovalCount) ||
    !requiredApprovalRoles.every((role) => role === "owner" || role === "independent_reviewer") ||
    !isValidApprovalRequirement(risk, requiredApprovalCount, requiredApprovalRoles)
  ) return null;
  const requesterHumanId = request.requesterHumanId ?? request.humanId;
  if (requesterHumanId !== request.humanId) return null;
  const organizationId = request.organizationId ?? (request.humanId === "user-c" ? "org-user-a" : `org-${request.humanId}`);
  if (typeof organizationId !== "string" || organizationId.length === 0) return null;
  const accountId = request.accountId ?? null;
  if (accountId !== null && (typeof accountId !== "string" || accountId.length === 0)) return null;
  return {
    payloadDigest: computedDigest,
    destination,
    policyRevision,
    resourceRevision,
    destinationRevision,
    risk,
    riskVersion,
    riskFactsDigest,
    requiredApprovalCount,
    requiredApprovalRoles,
    requesterHumanId,
    organizationId,
    accountId,
  };
}

function hasValidStoredDestinationBinding(value: {
  action: AgentGateAction;
  destination: string | null;
  destinationRevision: number | null;
}): boolean {
  if (value.action === "content.moderate") {
    return value.destination === null && value.destinationRevision === null;
  }
  if (
    value.action === "content.disclose" ||
    value.action === "content.publish" ||
    value.action === "content.export"
  ) {
    return isRegisteredDestinationId(value.destination) &&
      typeof value.destinationRevision === "number" &&
      Number.isInteger(value.destinationRevision) &&
      value.destinationRevision > 0;
  }
  return (
    (value.destination === null || value.destination.length > 0) &&
    value.destinationRevision === null
  );
}

function sameRequest(left: ApprovalRequest, right: ApprovalRecord): boolean {
  const binding = normalizeBinding(left);
  return (
    binding !== null &&
    left.humanId === right.humanId &&
    left.agentId === right.agentId &&
    left.runId === right.runId &&
    left.requestId === right.requestId &&
    left.action === right.action &&
    left.resourceId === right.resourceId &&
    right.payloadDigest === binding.payloadDigest &&
    right.destination === binding.destination &&
    right.policyRevision === binding.policyRevision &&
    right.resourceRevision === binding.resourceRevision &&
    right.destinationRevision === binding.destinationRevision &&
    right.requesterHumanId === binding.requesterHumanId &&
    right.risk === binding.risk &&
    right.riskVersion === binding.riskVersion &&
    right.riskFactsDigest === binding.riskFactsDigest &&
    right.requiredApprovalCount === binding.requiredApprovalCount &&
    arrayEquals(right.requiredApprovalRoles, binding.requiredApprovalRoles) &&
    right.organizationId === binding.organizationId &&
    right.accountId === binding.accountId &&
    (left.grantId ?? null) === (right.grantId ?? null) &&
    (left.teamId ?? null) === (right.teamId ?? null) &&
    (left.bundleVersion ?? null) === (right.bundleVersion ?? null) &&
    arrayEquals(left.effectiveScope, right.effectiveScope) &&
    (left.humanRole ?? null) === (right.humanRole ?? null) &&
    (left.agentRole ?? null) === (right.agentRole ?? null) &&
    (left.resourceClassification ?? null) === (right.resourceClassification ?? null) &&
    arrayEquals(left.temporaryScope, right.temporaryScope)
  );
}

function sameCapability(request: ApprovalRequest, lease: CapabilityLease): boolean {
  const binding = normalizeBinding(request);
  return (
    binding !== null &&
    lease.humanId === request.humanId &&
    lease.agentId === request.agentId &&
    lease.runId === request.runId &&
    lease.requestId === request.requestId &&
    lease.action === request.action &&
    lease.resourceId === request.resourceId &&
    lease.payloadDigest === binding.payloadDigest &&
    lease.destination === binding.destination &&
    lease.policyRevision === binding.policyRevision &&
    lease.resourceRevision === binding.resourceRevision &&
    lease.destinationRevision === binding.destinationRevision &&
    lease.requesterHumanId === binding.requesterHumanId &&
    lease.risk === binding.risk &&
    lease.riskVersion === binding.riskVersion &&
    lease.riskFactsDigest === binding.riskFactsDigest &&
    lease.requiredApprovalCount === binding.requiredApprovalCount &&
    arrayEquals(lease.requiredApprovalRoles, binding.requiredApprovalRoles) &&
    lease.organizationId === binding.organizationId &&
    lease.accountId === binding.accountId &&
    (lease.grantId ?? null) === (request.grantId ?? null) &&
    (lease.teamId ?? null) === (request.teamId ?? null) &&
    (lease.bundleVersion ?? null) === (request.bundleVersion ?? null) &&
    arrayEquals(lease.effectiveScope, request.effectiveScope) &&
    (lease.humanRole ?? null) === (request.humanRole ?? null) &&
    (lease.agentRole ?? null) === (request.agentRole ?? null) &&
    (lease.resourceClassification ?? null) === (request.resourceClassification ?? null) &&
    arrayEquals(lease.temporaryScope, request.temporaryScope)
  );
}

function evidence(value: ApprovalRecord | CapabilityLease) {
  return {
    riskVersion: value.riskVersion,
    riskFactsDigest: value.riskFactsDigest,
    requiredApprovalCount: value.requiredApprovalCount,
    requiredApprovalRoles: [...value.requiredApprovalRoles],
    approvalDecisions: value.approvalDecisions.map((decision) => ({ ...decision })),
    grantId: value.grantId ?? null,
    teamId: value.teamId ?? null,
    bundleVersion: value.bundleVersion ?? null,
    effectiveScope: value.effectiveScope ? [...value.effectiveScope] : null,
    humanRole: value.humanRole ?? null,
    agentRole: value.agentRole ?? null,
    resourceClassification: value.resourceClassification ?? null,
    temporaryScope: value.temporaryScope ? [...value.temporaryScope] : null,
  };
}

function approvalAuthorityRequest(
  value: ApprovalRecord,
  humanId: HumanId,
  role?: ApprovalAuthorityRole,
) {
  return {
    humanId,
    organizationId: value.organizationId,
    accountId: value.accountId,
    action: value.action,
    riskTier: value.risk,
    ...(role ? { role } : {}),
  };
}

function authorityDecisionIsCurrent(
  decision: ApprovalDecision,
  approval: ApprovalRecord,
  authorities: readonly ApprovalAuthority[],
): boolean {
  const authority = authorities.find((candidate) => candidate.id === decision.authorityId);
  return Boolean(
    authority &&
    authority.revision === decision.authorityRevision &&
    isApprovalAuthorityEligible(authority, approvalAuthorityRequest(approval, decision.humanId, decision.role)),
  );
}

function hasValidStoredApprovalBinding(approval: ApprovalRecord): boolean {
  return (
    typeof approval.payloadDigest === "string" && /^[0-9a-f]{64}$/.test(approval.payloadDigest) &&
    typeof approval.policyRevision === "string" && approval.policyRevision.length > 0 &&
    typeof approval.resourceRevision === "number" && Number.isInteger(approval.resourceRevision) && approval.resourceRevision > 0 &&
    hasValidStoredDestinationBinding(approval) &&
    typeof approval.requesterHumanId === "string" &&
    typeof approval.riskVersion === "string" && approval.riskVersion.length > 0 &&
    /^[0-9a-f]{64}$/.test(approval.riskFactsDigest) &&
    Number.isInteger(approval.requiredApprovalCount) && approval.requiredApprovalCount > 0 &&
    isValidApprovalRequirement(approval.risk, approval.requiredApprovalCount, approval.requiredApprovalRoles) &&
    approval.approvalDecisions.length <= approval.requiredApprovalCount &&
    new Set(approval.approvalDecisions.map((decision) => decision.humanId)).size === approval.approvalDecisions.length &&
    new Set(approval.approvalDecisions.map((decision) => decision.authorityId)).size === approval.approvalDecisions.length &&
    new Set(approval.approvalDecisions.map((decision) => decision.role)).size === approval.approvalDecisions.length &&
    approval.approvalDecisions.every((decision, index) =>
      decision.role === approval.requiredApprovalRoles[index] &&
      (decision.decision === "approve" || decision.decision === "deny"),
    ) &&
    typeof approval.organizationId === "string" && approval.organizationId.length > 0 &&
    (approval.accountId === null || (typeof approval.accountId === "string" && approval.accountId.length > 0))
  );
}

export class ApprovalService {
  constructor(
    private readonly store: JsonStore,
    private readonly audit: AuditService,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = DEFAULT_APPROVAL_TTL_MS,
  ) {}

  async getOrCreate(request: ApprovalRequest): Promise<ApprovalRecord> {
    if (!normalizeBinding(request)) throw new ApprovalError("IDEMPOTENCY_MISMATCH", "Approval request binding is invalid");
    let expiredApproval: ApprovalRecord | null = null;
    const approval = await this.store.mutate((database) => {
      const existing = database.approvals.find(
        (candidate) =>
          candidate.requestId === request.requestId &&
          candidate.agentId === request.agentId &&
          candidate.runId === request.runId,
      );
      if (existing && !sameRequest(request, existing)) {
        throw new ApprovalError("IDEMPOTENCY_MISMATCH", "Approval request does not match the original operation");
      }
      if (existing) {
        if (existing.status === "pending" && this.isExpired(existing)) {
          existing.status = "expired";
          expiredApproval = structuredClone(existing);
        }
        return structuredClone(existing);
      }

      const binding = normalizeBinding(request)!;
      const createdAt = new Date(this.now()).toISOString();
      const next: ApprovalRecord = {
        id: randomUUID(),
        humanId: request.humanId,
        agentId: request.agentId,
        runId: request.runId,
        requestId: request.requestId,
        action: request.action,
        resourceId: request.resourceId,
        risk: binding.risk,
        reasonCode: request.reasonCode,
        status: "pending",
        createdAt,
        decidedAt: null,
        expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
        payloadDigest: binding.payloadDigest,
        destination: binding.destination,
        policyRevision: binding.policyRevision,
        resourceRevision: binding.resourceRevision,
        destinationRevision: binding.destinationRevision,
        ...(request.grantId ? { grantId: request.grantId } : {}),
        ...(request.teamId ? { teamId: request.teamId } : {}),
        ...(request.bundleVersion ? { bundleVersion: request.bundleVersion } : {}),
        ...(request.effectiveScope ? { effectiveScope: [...request.effectiveScope] } : {}),
        ...(request.humanRole ? { humanRole: request.humanRole } : {}),
        ...(request.agentRole ? { agentRole: request.agentRole } : {}),
        ...(request.resourceClassification ? { resourceClassification: request.resourceClassification } : {}),
        ...(request.temporaryScope ? { temporaryScope: [...request.temporaryScope] } : {}),
        requesterHumanId: binding.requesterHumanId,
        riskVersion: binding.riskVersion,
        riskFactsDigest: binding.riskFactsDigest,
        requiredApprovalCount: binding.requiredApprovalCount,
        requiredApprovalRoles: [...binding.requiredApprovalRoles],
        approvalDecisions: [],
        organizationId: binding.organizationId,
        accountId: binding.accountId,
      };
      database.approvals.push(next);
      return structuredClone(next);
    });
    if (expiredApproval) await this.recordApprovalExpired(expiredApproval);
    return approval;
  }

  async get(approvalId: string): Promise<ApprovalRecord | null> {
    let expiredApproval: ApprovalRecord | null = null;
    const approval = await this.store.mutate((database) => {
      const record = database.approvals.find((candidate) => candidate.id === approvalId);
      if (!record) return null;
      if (record.status === "pending" && this.isExpired(record)) {
        record.status = "expired";
        expiredApproval = structuredClone(record);
      }
      return structuredClone(record);
    });
    if (expiredApproval) await this.recordApprovalExpired(expiredApproval);
    return approval;
  }

  async list(humanId: HumanId, status?: ApprovalRecord["status"], agentId?: string): Promise<ApprovalRecord[]> {
    const database = this.store.snapshot();
    return database.approvals
      .filter((approval) =>
        (approval.humanId === humanId || approval.requiredApprovalRoles.some((role) =>
          database.approvalAuthorities.some((authority) =>
            authority.humanId === humanId &&
            isApprovalAuthorityEligible(authority, approvalAuthorityRequest(approval, humanId, role)),
          ),
        )) &&
        (status === undefined || approval.status === status) &&
        (agentId === undefined || approval.agentId === agentId),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async approve(approvalId: string, humanId: HumanId): Promise<{ approval: ApprovalRecord; capability: CapabilityLease | null }> {
    let expiredApproval: ApprovalRecord | null = null;
    const outcome = await this.store.mutate<{ approval: ApprovalRecord; capability: CapabilityLease | null }>((database) => {
      const approval = database.approvals.find((candidate) => candidate.id === approvalId);
      if (!approval) throw new ApprovalError("APPROVAL_NOT_FOUND", "Approval not found");
      if (approval.status === "pending" && this.isExpired(approval)) {
        approval.status = "expired";
        expiredApproval = structuredClone(approval);
        return { approval: structuredClone(approval), capability: null };
      }
      if (approval.status === "expired") throw new ApprovalError("APPROVAL_EXPIRED", "Approval has expired");
      if (approval.status === "denied") throw new ApprovalError("APPROVAL_DENIED", "Approval was denied");
      if (approval.status === "revoked") throw new ApprovalError("APPROVAL_REVOKED", "Approval was revoked");
      if (approval.status !== "pending") throw new ApprovalError("APPROVAL_ALREADY_DECIDED", "Approval is no longer pending");
      if (!hasValidStoredApprovalBinding(approval)) {
        throw new ApprovalError("APPROVAL_INVALID", "Approval is missing its exact operation binding");
      }
      if (approval.approvalDecisions.some((decision) => !authorityDecisionIsCurrent(decision, approval, database.approvalAuthorities))) {
        throw new ApprovalError("APPROVAL_REVOKED", "An approval authority was revoked");
      }
      if (approval.approvalDecisions.some((decision) => decision.humanId === humanId)) {
        throw new ApprovalError("APPROVAL_ALREADY_DECIDED", "This human already decided this approval");
      }
      const role = approval.requiredApprovalRoles.find((candidate) =>
        !approval.approvalDecisions.some((decision) => decision.role === candidate),
      );
      if (!role) throw new ApprovalError("APPROVAL_ALREADY_DECIDED", "Approval is no longer pending");
      const authority = database.approvalAuthorities.find((candidate) =>
        isApprovalAuthorityEligible(candidate, approvalAuthorityRequest(approval, humanId, role)),
      );
      if (!authority) throw new ApprovalError("APPROVAL_NOT_OWNED", "Human is not eligible for this approval slot");

      const decidedAt = new Date(this.now()).toISOString();
      approval.approvalDecisions.push({
        humanId,
        authorityId: authority.id,
        authorityRevision: authority.revision,
        role,
        decision: "approve",
        decidedAt,
      });
      if (approval.approvalDecisions.length < approval.requiredApprovalCount) {
        return { approval: structuredClone(approval), capability: null };
      }

      const issuedAt = decidedAt;
      const capability: CapabilityClaim = {
        id: randomUUID(),
        approvalId: approval.id,
        humanId: approval.humanId,
        agentId: approval.agentId,
        runId: approval.runId,
        action: approval.action,
        resourceId: approval.resourceId,
        requestId: approval.requestId,
        issuedAt,
        expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
        remainingUses: 1,
        payloadDigest: approval.payloadDigest!,
        destination: approval.destination,
        policyRevision: approval.policyRevision!,
        resourceRevision: approval.resourceRevision!,
        destinationRevision: approval.destinationRevision,
        risk: approval.risk,
        riskVersion: approval.riskVersion,
        riskFactsDigest: approval.riskFactsDigest,
        requiredApprovalCount: approval.requiredApprovalCount,
        requiredApprovalRoles: [...approval.requiredApprovalRoles],
        approvalDecisions: approval.approvalDecisions.map((decision) => ({ ...decision })),
        requesterHumanId: approval.requesterHumanId,
        organizationId: approval.organizationId,
        accountId: approval.accountId,
        ...(approval.grantId ? { grantId: approval.grantId } : {}),
        ...(approval.teamId ? { teamId: approval.teamId } : {}),
        ...(approval.bundleVersion ? { bundleVersion: approval.bundleVersion } : {}),
        ...(approval.effectiveScope ? { effectiveScope: [...approval.effectiveScope] } : {}),
        ...(approval.humanRole ? { humanRole: approval.humanRole } : {}),
        ...(approval.agentRole ? { agentRole: approval.agentRole } : {}),
        ...(approval.resourceClassification ? { resourceClassification: approval.resourceClassification } : {}),
        ...(approval.temporaryScope ? { temporaryScope: [...approval.temporaryScope] } : {}),
      };
      approval.status = "approved";
      approval.decidedAt = issuedAt;
      database.capabilityClaims.push(structuredClone(capability));
      return { approval: structuredClone(approval), capability: structuredClone(capability) };
    });
    if (expiredApproval) {
      await this.recordApprovalExpired(expiredApproval);
      throw new ApprovalError("APPROVAL_EXPIRED", "Approval has expired");
    }
    await this.audit.record({
      eventType: "approval.approved", humanId, agentId: outcome.approval.agentId,
      runId: outcome.approval.runId, requestId: outcome.approval.requestId, action: outcome.approval.action,
      resourceId: outcome.approval.resourceId, decision: "allow", risk: outcome.approval.risk, reasonCode: outcome.approval.reasonCode,
      approvalId: outcome.approval.id, capabilityId: null, status: "success", durationMs: null,
      policyVersion: AGENTGATE_POLICY_VERSION, explanation: outcome.capability
        ? "An eligible human approved this exact scoped protected action."
        : "An eligible human approved one required slot; the protected action remains pending independent approval.",
      enforcementPoint: "ApprovalService", protectedActionExecuted: false, ...evidence(outcome.approval),
    });
    if (outcome.capability) {
      await this.audit.record({
        eventType: "capability.issued", humanId: outcome.capability.humanId, agentId: outcome.capability.agentId,
        runId: outcome.capability.runId, requestId: outcome.capability.requestId, action: outcome.capability.action,
        resourceId: outcome.capability.resourceId, decision: null, risk: outcome.capability.risk, reasonCode: "approval_granted",
        approvalId: outcome.capability.approvalId, capabilityId: outcome.capability.id, status: "success", durationMs: null,
        policyVersion: AGENTGATE_POLICY_VERSION, explanation: "A durable one-use capability claim was issued for the exact approved action scope.",
        enforcementPoint: "ApprovalService", protectedActionExecuted: false, ...evidence(outcome.capability),
      });
    }
    return outcome;
  }

  capabilityStatus(approvalId: string): "usable" | "expired" | "missing" | "revoked" {
    const database = this.store.snapshot();
    const approval = database.approvals.find((candidate) => candidate.id === approvalId);
    if (approval?.status === "revoked") return "revoked";
    const capability = database.capabilityClaims.find((candidate) => candidate.approvalId === approvalId);
    if (!capability || capability.remainingUses === 0) return "missing";
    return this.isExpired(capability) ? "expired" : "usable";
  }

  async deny(approvalId: string, humanId: HumanId): Promise<ApprovalRecord> {
    let expiredApproval: ApprovalRecord | null = null;
    const approval = await this.store.mutate((database) => {
      const record = database.approvals.find((candidate) => candidate.id === approvalId);
      if (!record) throw new ApprovalError("APPROVAL_NOT_FOUND", "Approval not found");
      if (record.status === "pending" && this.isExpired(record)) {
        record.status = "expired";
        expiredApproval = structuredClone(record);
      } else if (record.status === "expired") {
        throw new ApprovalError("APPROVAL_EXPIRED", "Approval has expired");
      } else if (record.status !== "pending") {
        if (record.status === "revoked") throw new ApprovalError("APPROVAL_REVOKED", "Approval was revoked");
        throw new ApprovalError("APPROVAL_ALREADY_DECIDED", "Approval is no longer pending");
      } else {
        if (!hasValidStoredApprovalBinding(record)) {
          throw new ApprovalError("APPROVAL_INVALID", "Approval is missing its exact operation binding");
        }
        if (record.approvalDecisions.some((decision) => !authorityDecisionIsCurrent(decision, record, database.approvalAuthorities))) {
          throw new ApprovalError("APPROVAL_REVOKED", "An approval authority was revoked");
        }
        if (record.approvalDecisions.some((decision) => decision.humanId === humanId)) {
          throw new ApprovalError("APPROVAL_ALREADY_DECIDED", "This human already decided this approval");
        }
        const role = record.requiredApprovalRoles.find((candidate) =>
          !record.approvalDecisions.some((decision) => decision.role === candidate),
        );
        const authority = role
          ? database.approvalAuthorities.find((candidate) =>
              isApprovalAuthorityEligible(candidate, approvalAuthorityRequest(record, humanId, role)),
            )
          : undefined;
        if (!authority) throw new ApprovalError("APPROVAL_NOT_OWNED", "Human is not eligible for this approval slot");
        record.approvalDecisions.push({
          humanId,
          authorityId: authority.id,
          authorityRevision: authority.revision,
          role: authority.role,
          decision: "deny",
          decidedAt: new Date(this.now()).toISOString(),
        });
        record.status = "denied";
        record.decidedAt = record.approvalDecisions.at(-1)!.decidedAt;
      }
      return structuredClone(record);
    });
    if (expiredApproval) {
      await this.recordApprovalExpired(expiredApproval);
      throw new ApprovalError("APPROVAL_EXPIRED", "Approval has expired");
    }
    await this.audit.record({
      eventType: "approval.denied", humanId: approval.humanId, agentId: approval.agentId, runId: approval.runId,
      requestId: approval.requestId, action: approval.action, resourceId: approval.resourceId, decision: "deny", risk: approval.risk,
      reasonCode: approval.reasonCode, approvalId: approval.id, capabilityId: null, status: "success", durationMs: null,
      policyVersion: AGENTGATE_POLICY_VERSION, explanation: "An eligible human denied this protected action before execution.",
      enforcementPoint: "ApprovalService", protectedActionExecuted: false, ...evidence(approval),
    });
    return approval;
  }

  async consumeCapability(request: ApprovalRequest & { approvalId: string }): Promise<CapabilityConsumption> {
    if (!normalizeBinding(request)) return { status: "denied", reasonCode: "invalid_capability" };
    let expiredApproval: ApprovalRecord | null = null;
    const outcome = await this.store.mutate<CapabilityConsumption>((database) => {
      const approval = database.approvals.find((candidate) => candidate.id === request.approvalId);
      if (!approval) return { status: "denied", reasonCode: "invalid_capability" };
      if (approval.status === "consumed") return { status: "denied", reasonCode: "capability_consumed" };
      if (approval.status === "revoked") {
        return {
          status: "denied",
          reasonCode: approval.reasonCode === "approval_authority_revoked"
            ? "approval_authority_revoked"
            : "capability_revoked",
        };
      }
      if (!sameRequest(request, approval)) return { status: "denied", reasonCode: "invalid_capability" };
      if (approval.status === "pending" && this.isExpired(approval)) {
        approval.status = "expired";
        expiredApproval = structuredClone(approval);
        return { status: "denied", reasonCode: "approval_expired" };
      }
      if (approval.status === "denied") return { status: "denied", reasonCode: "approval_denied" };
      if (approval.status === "expired") return { status: "denied", reasonCode: "approval_expired" };
      if (approval.status === "pending") return { status: "pending", approval: structuredClone(approval) };
      if (approval.status !== "approved") return { status: "denied", reasonCode: "invalid_capability" };
      if (!hasValidStoredApprovalBinding(approval) || approval.approvalDecisions.length !== approval.requiredApprovalCount) {
        return { status: "denied", reasonCode: "invalid_capability" };
      }
      if (approval.approvalDecisions.some((decision) => !authorityDecisionIsCurrent(decision, approval, database.approvalAuthorities))) {
        const staleClaim = database.capabilityClaims.find((candidate) => candidate.approvalId === approval.id);
        if (staleClaim) staleClaim.remainingUses = 0;
        approval.status = "revoked";
        approval.reasonCode = "approval_authority_revoked";
        approval.decidedAt = new Date(this.now()).toISOString();
        return { status: "denied", reasonCode: "approval_authority_revoked" };
      }
      const capability = database.capabilityClaims.find((candidate) => candidate.approvalId === approval.id);
      if (
        !capability ||
        !sameCapability(request, capability) ||
        JSON.stringify(capability.approvalDecisions) !== JSON.stringify(approval.approvalDecisions)
      ) return { status: "denied", reasonCode: "invalid_capability" };
      if (capability.remainingUses === 0) return { status: "denied", reasonCode: "capability_consumed" };
      if (capability.remainingUses !== 1) return { status: "denied", reasonCode: "invalid_capability" };
      if (this.isExpired(capability)) {
        capability.remainingUses = 0;
        approval.status = "expired";
        expiredApproval = structuredClone(approval);
        return { status: "denied", reasonCode: "approval_expired" };
      }
      // JsonStore serializes and atomically persists this transition. There
      // is no usable in-memory lease to race or reconstruct separately.
      capability.remainingUses = 0;
      approval.status = "consumed";
      return { status: "consumed", capability: structuredClone(capability) };
    });
    if (expiredApproval) await this.recordApprovalExpired(expiredApproval);
    if (outcome.status === "consumed") {
      await this.audit.record({
        eventType: "capability.consumed", humanId: outcome.capability.humanId, agentId: outcome.capability.agentId,
        runId: outcome.capability.runId, requestId: outcome.capability.requestId, action: outcome.capability.action,
        resourceId: outcome.capability.resourceId, decision: "allow", risk: outcome.capability.risk, reasonCode: "capability_consumed",
        approvalId: outcome.capability.approvalId, capabilityId: outcome.capability.id, status: "success", durationMs: null,
        policyVersion: AGENTGATE_POLICY_VERSION, explanation: "The one-use capability claim was consumed for its exact bound request.",
        enforcementPoint: "ApprovalService", protectedActionExecuted: false, ...evidence(outcome.capability),
      });
    }
    return outcome;
  }

  async revokeForRun(runId: string, reasonCode = "owner_revoked"): Promise<ApprovalRecord[]> {
    return this.revokeClaims((approval) => approval.runId === runId, (claim) => claim.runId === runId, reasonCode);
  }

  async revokeForGrant(grantId: string, reasonCode = "agent_grant_revoked"): Promise<ApprovalRecord[]> {
    return this.revokeClaims((approval) => approval.grantId === grantId, (claim) => claim.grantId === grantId, reasonCode);
  }

  async revokeForResource(resourceId: string, reasonCode = "resource_revoked"): Promise<ApprovalRecord[]> {
    return this.revokeClaims((approval) => approval.resourceId === resourceId, (claim) => claim.resourceId === resourceId, reasonCode);
  }

  async revokeForDestination(destinationId: string, reasonCode = "destination_revision_changed"): Promise<ApprovalRecord[]> {
    return this.revokeClaims(
      (approval) => approval.destination === destinationId,
      (claim) => claim.destination === destinationId,
      reasonCode,
    );
  }

  async revokeForAuthority(authorityId: string, reasonCode = "approval_authority_revoked"): Promise<ApprovalRecord[]> {
    return this.revokeClaims(
      (approval) => approval.approvalDecisions.some((decision) => decision.authorityId === authorityId),
      (claim) => claim.approvalDecisions.some((decision) => decision.authorityId === authorityId),
      reasonCode,
    );
  }

  isConsumedClaimValid(request: ApprovalRequest & { approvalId: string }): boolean {
    const binding = normalizeBinding(request);
    if (!binding) return false;
    const database = this.store.snapshot();
    const approval = database.approvals.find((candidate) => candidate.id === request.approvalId);
    const claim = database.capabilityClaims.find((candidate) => candidate.approvalId === request.approvalId);
    if (!approval || !claim || approval.status !== "consumed" || claim.remainingUses !== 0) return false;
    return (
      hasValidStoredApprovalBinding(approval) &&
      approval.approvalDecisions.length === approval.requiredApprovalCount &&
      approval.approvalDecisions.every((decision) => authorityDecisionIsCurrent(decision, approval, database.approvalAuthorities)) &&
      sameRequest(request, approval) &&
      sameCapability(request, claim) &&
      JSON.stringify(claim.approvalDecisions) === JSON.stringify(approval.approvalDecisions)
    );
  }

  private async revokeClaims(
    matchesApproval: (approval: ApprovalRecord) => boolean,
    matchesClaim: (claim: CapabilityClaim) => boolean,
    reasonCode: string,
  ): Promise<ApprovalRecord[]> {
    const revoked = await this.store.mutate((database) => {
      for (const claim of database.capabilityClaims) {
        if (matchesClaim(claim)) claim.remainingUses = 0;
      }
      const changed: ApprovalRecord[] = [];
      for (const approval of database.approvals) {
        if (!matchesApproval(approval) || !["pending", "approved"].includes(approval.status)) continue;
        approval.status = "revoked";
        approval.reasonCode = reasonCode;
        approval.decidedAt = new Date(this.now()).toISOString();
        changed.push(structuredClone(approval));
      }
      return changed;
    });
    for (const approval of revoked) {
      await this.audit.record({
        eventType: "approval.revoked", humanId: approval.humanId, agentId: approval.agentId, runId: approval.runId,
        requestId: approval.requestId, action: approval.action, resourceId: approval.resourceId, decision: "deny", risk: approval.risk,
        reasonCode, approvalId: approval.id, capabilityId: null, status: "failure", durationMs: null,
        policyVersion: AGENTGATE_POLICY_VERSION,
        explanation: "The mutable authority behind this approval was revoked before the protected action could execute.",
        enforcementPoint: "ApprovalService", protectedActionExecuted: false, ...evidence(approval),
      });
    }
    return revoked;
  }

  private isExpired(value: { expiresAt: string }): boolean {
    return new Date(value.expiresAt).getTime() <= this.now();
  }

  private async recordApprovalExpired(approval: ApprovalRecord): Promise<void> {
    await this.audit.record({
      eventType: "approval.expired", humanId: approval.humanId, agentId: approval.agentId, runId: approval.runId,
      requestId: approval.requestId, action: approval.action, resourceId: approval.resourceId, decision: "deny", risk: approval.risk,
      reasonCode: "approval_expired", approvalId: approval.id, capabilityId: null, status: "failure", durationMs: null,
      policyVersion: AGENTGATE_POLICY_VERSION, explanation: "The approval window expired before the protected action executed.",
      enforcementPoint: "ApprovalService", protectedActionExecuted: false, ...evidence(approval),
    });
  }
}

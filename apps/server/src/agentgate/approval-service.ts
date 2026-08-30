import { randomUUID } from "node:crypto";
import { AuditService } from "./audit-service.js";
import {
  AGENTGATE_POLICY_VERSION,
  type ApprovalRecord,
  type AgentGateAction,
  type CapabilityLease,
  type HumanId,
  type ResourceClassification,
  type TeamId,
  type TeamRole,
} from "./types.js";
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
  grantId?: string | null;
  teamId?: TeamId | null;
  bundleVersion?: number | null;
  effectiveScope?: string[] | null;
  humanRole?: TeamRole | null;
  agentRole?: TeamRole | null;
  resourceClassification?: ResourceClassification | null;
  temporaryScope?: string[] | null;
}

export type CapabilityConsumption =
  | { status: "consumed"; capability: CapabilityLease }
  | { status: "pending"; approval: ApprovalRecord }
  | {
      status: "denied";
      reasonCode: "approval_denied" | "approval_expired" | "capability_consumed" | "capability_revoked" | "invalid_capability";
    };

export type ApprovalErrorCode =
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_NOT_OWNED"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_DENIED"
  | "APPROVAL_REVOKED"
  | "APPROVAL_ALREADY_DECIDED"
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

function sameRequest(left: ApprovalRequest, right: ApprovalRecord): boolean {
  return (
    left.humanId === right.humanId &&
    left.agentId === right.agentId &&
    left.runId === right.runId &&
    left.requestId === right.requestId &&
    left.action === right.action &&
    left.resourceId === right.resourceId &&
    (left.grantId ?? null) === (right.grantId ?? null) &&
    (left.teamId ?? null) === (right.teamId ?? null) &&
    (left.bundleVersion ?? null) === (right.bundleVersion ?? null) &&
    (left.effectiveScope ?? null)?.join("\u0000") === (right.effectiveScope ?? null)?.join("\u0000") &&
    (left.humanRole ?? null) === (right.humanRole ?? null) &&
    (left.agentRole ?? null) === (right.agentRole ?? null) &&
    (left.resourceClassification ?? null) === (right.resourceClassification ?? null) &&
    (left.temporaryScope ?? null)?.join("\u0000") === (right.temporaryScope ?? null)?.join("\u0000")
  );
}

function sameCapability(
  request: ApprovalRequest,
  lease: CapabilityLease,
): boolean {
  return (
    lease.humanId === request.humanId &&
    lease.agentId === request.agentId &&
    lease.runId === request.runId &&
    lease.requestId === request.requestId &&
    lease.action === request.action &&
    lease.resourceId === request.resourceId &&
    (lease.grantId ?? null) === (request.grantId ?? null) &&
    (lease.teamId ?? null) === (request.teamId ?? null) &&
    (lease.bundleVersion ?? null) === (request.bundleVersion ?? null) &&
    (lease.effectiveScope ?? null)?.join("\u0000") === (request.effectiveScope ?? null)?.join("\u0000") &&
    (lease.humanRole ?? null) === (request.humanRole ?? null) &&
    (lease.agentRole ?? null) === (request.agentRole ?? null) &&
    (lease.resourceClassification ?? null) === (request.resourceClassification ?? null) &&
    (lease.temporaryScope ?? null)?.join("\u0000") === (request.temporaryScope ?? null)?.join("\u0000")
  );
}

function evidence(value: ApprovalRecord | CapabilityLease) {
  return {
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

export class ApprovalService {
  private readonly capabilities = new Map<string, CapabilityLease>();

  constructor(
    private readonly store: JsonStore,
    private readonly audit: AuditService,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = DEFAULT_APPROVAL_TTL_MS,
  ) {}

  async getOrCreate(request: ApprovalRequest): Promise<ApprovalRecord> {
    let expiredApproval: ApprovalRecord | null = null;
    const approval = await this.store.mutate((database) => {
      const existing = database.approvals.find(
        (candidate) =>
          candidate.requestId === request.requestId &&
          candidate.agentId === request.agentId &&
          candidate.runId === request.runId,
      );
      if (existing && !sameRequest(request, existing)) {
        throw new ApprovalError(
          "IDEMPOTENCY_MISMATCH",
          "Approval request does not match the original operation",
        );
      }
      if (existing) {
        if (existing.status === "pending" && this.isExpired(existing)) {
          existing.status = "expired";
          expiredApproval = structuredClone(existing);
        }
        // requestId is the idempotency key for the intended operation. A
        // denied or expired request must remain terminal; it must not mint a
        // fresh approval when the Agent retries the same request.
        return structuredClone(existing);
      }

      const createdAt = new Date(this.now()).toISOString();
      const next: ApprovalRecord = {
        id: randomUUID(),
        humanId: request.humanId,
        agentId: request.agentId,
        runId: request.runId,
        requestId: request.requestId,
        action: request.action,
        resourceId: request.resourceId,
        risk: "high",
        reasonCode: request.reasonCode,
        status: "pending",
        createdAt,
        decidedAt: null,
        expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
        ...(request.grantId ? { grantId: request.grantId } : {}),
        ...(request.teamId ? { teamId: request.teamId } : {}),
        ...(request.bundleVersion ? { bundleVersion: request.bundleVersion } : {}),
        ...(request.effectiveScope ? { effectiveScope: [...request.effectiveScope] } : {}),
        ...(request.humanRole ? { humanRole: request.humanRole } : {}),
        ...(request.agentRole ? { agentRole: request.agentRole } : {}),
        ...(request.resourceClassification ? { resourceClassification: request.resourceClassification } : {}),
        ...(request.temporaryScope ? { temporaryScope: [...request.temporaryScope] } : {}),
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

  async list(
    humanId: HumanId,
    status?: ApprovalRecord["status"],
    agentId?: string,
  ): Promise<ApprovalRecord[]> {
    const approvals = (await this.store.snapshot()).approvals;
    return approvals
      .filter(
        (approval) =>
          approval.humanId === humanId &&
          (status === undefined || approval.status === status) &&
          (agentId === undefined || approval.agentId === agentId),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async approve(
    approvalId: string,
    humanId: HumanId,
  ): Promise<{ approval: ApprovalRecord; capability: CapabilityLease }> {
    let expiredApproval: ApprovalRecord | null = null;
    const outcome = await this.store.mutate((database) => {
      const approval = database.approvals.find((candidate) => candidate.id === approvalId);
      if (!approval) {
        throw new ApprovalError("APPROVAL_NOT_FOUND", "Approval not found");
      }
      if (approval.humanId !== humanId) {
        throw new ApprovalError("APPROVAL_NOT_OWNED", "Approval belongs to another user");
      }
      if (approval.status === "pending" && this.isExpired(approval)) {
        approval.status = "expired";
        expiredApproval = structuredClone(approval);
        return null;
      }
      if (approval.status === "expired") {
        throw new ApprovalError("APPROVAL_EXPIRED", "Approval has expired");
      }
      if (approval.status === "denied") {
        throw new ApprovalError("APPROVAL_DENIED", "Approval was denied");
      }
      if (approval.status === "revoked") {
        throw new ApprovalError("APPROVAL_REVOKED", "Approval was revoked");
      }
      if (approval.status !== "pending") {
        throw new ApprovalError("APPROVAL_ALREADY_DECIDED", "Approval is no longer pending");
      }

      const issuedAt = new Date(this.now()).toISOString();
      const capability: CapabilityLease = {
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
      return { approval: structuredClone(approval), capability: structuredClone(capability) };
    });
    if (expiredApproval) {
      await this.recordApprovalExpired(expiredApproval);
      throw new ApprovalError("APPROVAL_EXPIRED", "Approval has expired");
    }
    if (!outcome) {
      throw new ApprovalError("APPROVAL_EXPIRED", "Approval has expired");
    }
    // Install the ephemeral lease only after JsonStore has durably committed
    // the approved state. A failed approval write can never leave a usable
    // in-memory capability behind.
    this.capabilities.set(outcome.approval.id, structuredClone(outcome.capability));
    await this.audit.record({
      eventType: "approval.approved",
      humanId: outcome.approval.humanId,
      agentId: outcome.approval.agentId,
      runId: outcome.approval.runId,
      requestId: outcome.approval.requestId,
      action: outcome.approval.action,
      resourceId: outcome.approval.resourceId,
      decision: "allow",
      risk: "high",
      reasonCode: outcome.approval.reasonCode,
      approvalId: outcome.approval.id,
      capabilityId: null,
      status: "success",
      durationMs: null,
      policyVersion: AGENTGATE_POLICY_VERSION,
      explanation: "The owner approved this exact scoped protected action.",
      enforcementPoint: "ApprovalService",
      protectedActionExecuted: false,
      ...evidence(outcome.approval),
    });
    await this.audit.record({
      eventType: "capability.issued",
      humanId: outcome.capability.humanId,
      agentId: outcome.capability.agentId,
      runId: outcome.capability.runId,
      requestId: outcome.capability.requestId,
      action: outcome.capability.action,
      resourceId: outcome.capability.resourceId,
      decision: null,
      risk: "high",
      reasonCode: "owner_approval_granted",
      approvalId: outcome.capability.approvalId,
      capabilityId: outcome.capability.id,
      status: "success",
      durationMs: null,
      policyVersion: AGENTGATE_POLICY_VERSION,
      explanation: "A one-use capability was issued for the exact approved action scope.",
      enforcementPoint: "ApprovalService",
      protectedActionExecuted: false,
      ...evidence(outcome.capability),
    });
    return outcome;
  }

  capabilityStatus(approvalId: string): "usable" | "expired" | "missing" | "revoked" {
    const approval = this.store.snapshot().approvals.find((candidate) => candidate.id === approvalId);
    if (approval?.status === "revoked") return "revoked";
    const capability = this.capabilities.get(approvalId);
    if (!capability || capability.remainingUses === 0) return "missing";
    return this.isExpired(capability) ? "expired" : "usable";
  }

  async deny(approvalId: string, humanId: HumanId): Promise<ApprovalRecord> {
    let expiredApproval: ApprovalRecord | null = null;
    const approval = await this.store.mutate((database) => {
      const record = database.approvals.find((candidate) => candidate.id === approvalId);
      if (!record) throw new ApprovalError("APPROVAL_NOT_FOUND", "Approval not found");
      if (record.humanId !== humanId) {
        throw new ApprovalError("APPROVAL_NOT_OWNED", "Approval belongs to another user");
      }
      if (record.status === "pending" && this.isExpired(record)) {
        record.status = "expired";
        expiredApproval = structuredClone(record);
      } else if (record.status === "expired") {
        throw new ApprovalError("APPROVAL_EXPIRED", "Approval has expired");
      } else if (record.status !== "pending") {
        if (record.status === "revoked") {
          throw new ApprovalError("APPROVAL_REVOKED", "Approval was revoked");
        }
        throw new ApprovalError("APPROVAL_ALREADY_DECIDED", "Approval is no longer pending");
      } else {
        record.status = "denied";
        record.decidedAt = new Date(this.now()).toISOString();
      }
      return structuredClone(record);
    });
    if (expiredApproval) {
      await this.recordApprovalExpired(expiredApproval);
      throw new ApprovalError("APPROVAL_EXPIRED", "Approval has expired");
    }
    await this.audit.record({
      eventType: "approval.denied",
      humanId: approval.humanId,
      agentId: approval.agentId,
      runId: approval.runId,
      requestId: approval.requestId,
      action: approval.action,
      resourceId: approval.resourceId,
      decision: "deny",
      risk: "high",
      reasonCode: approval.reasonCode,
      approvalId: approval.id,
      capabilityId: null,
      status: "success",
      durationMs: null,
      policyVersion: AGENTGATE_POLICY_VERSION,
      explanation: "The owner denied this protected action before execution.",
      enforcementPoint: "ApprovalService",
      protectedActionExecuted: false,
      ...evidence(approval),
    });
    return approval;
  }

  async consumeCapability(request: ApprovalRequest & { approvalId: string }): Promise<CapabilityConsumption> {
    let expiredApproval: ApprovalRecord | null = null;
    const outcome = await this.store.mutate<CapabilityConsumption>((database) => {
      const approval = database.approvals.find((candidate) => candidate.id === request.approvalId);
      if (!approval) {
        return { status: "denied", reasonCode: "invalid_capability" };
      }
      // Check terminal state before request binding so a replay with a fresh
      // requestId is reported as consumed/revoked without ever accepting a
      // capability for a different target.
      if (approval.status === "consumed") {
        return { status: "denied", reasonCode: "capability_consumed" };
      }
      if (approval.status === "revoked") {
        return { status: "denied", reasonCode: "capability_revoked" };
      }
      if (!sameRequest(request, approval)) {
        return { status: "denied", reasonCode: "invalid_capability" };
      }
      if (approval.status === "pending" && this.isExpired(approval)) {
        approval.status = "expired";
        expiredApproval = structuredClone(approval);
        return { status: "denied", reasonCode: "approval_expired" };
      }
      if (approval.status === "denied") {
        return { status: "denied", reasonCode: "approval_denied" };
      }
      if (approval.status === "expired") {
        return { status: "denied", reasonCode: "approval_expired" };
      }
      if (approval.status !== "approved") {
        return { status: "denied", reasonCode: "invalid_capability" };
      }
      const capability = this.capabilities.get(approval.id);
      if (!capability || !sameCapability(request, capability)) {
        return { status: "denied", reasonCode: "invalid_capability" };
      }
      if (capability.remainingUses === 0) {
        return { status: "denied", reasonCode: "capability_consumed" };
      }
      if (this.isExpired(capability)) {
        capability.remainingUses = 0;
        approval.status = "expired";
        expiredApproval = structuredClone(approval);
        return { status: "denied", reasonCode: "approval_expired" };
      }
      capability.remainingUses = 0;
      approval.status = "consumed";
      return { status: "consumed", capability: structuredClone(capability) };
    });
    if (expiredApproval) await this.recordApprovalExpired(expiredApproval);
    if (outcome.status === "consumed") {
      await this.audit.record({
        eventType: "capability.consumed",
        humanId: outcome.capability.humanId,
        agentId: outcome.capability.agentId,
        runId: outcome.capability.runId,
        requestId: outcome.capability.requestId,
        action: outcome.capability.action,
        resourceId: outcome.capability.resourceId,
        decision: "allow",
        risk: "high",
        reasonCode: "capability_consumed",
        approvalId: outcome.capability.approvalId,
        capabilityId: outcome.capability.id,
        status: "success",
        durationMs: null,
        policyVersion: AGENTGATE_POLICY_VERSION,
        explanation: "The one-use capability was consumed for its exact bound request.",
        enforcementPoint: "ApprovalService",
        protectedActionExecuted: false,
        ...evidence(outcome.capability),
      });
    }
    return outcome;
  }

  async revokeForRun(runId: string, reasonCode = "owner_revoked"): Promise<ApprovalRecord[]> {
    const revoked = await this.store.mutate((database) => {
      const changed: ApprovalRecord[] = [];
      for (const approval of database.approvals) {
        if (approval.runId !== runId || !["pending", "approved"].includes(approval.status)) {
          continue;
        }
        approval.status = "revoked";
        approval.decidedAt = new Date(this.now()).toISOString();
        changed.push(structuredClone(approval));
      }
      return changed;
    });
    for (const approval of revoked) {
      this.capabilities.delete(approval.id);
      await this.audit.record({
        eventType: "approval.revoked",
        humanId: approval.humanId,
        agentId: approval.agentId,
        runId: approval.runId,
        requestId: approval.requestId,
        action: approval.action,
        resourceId: approval.resourceId,
        decision: "deny",
        risk: "high",
        reasonCode,
        approvalId: approval.id,
        capabilityId: null,
        status: "failure",
        durationMs: null,
        policyVersion: AGENTGATE_POLICY_VERSION,
        explanation: "Owner revoked the Run's authority before the protected action could execute.",
        enforcementPoint: "ApprovalService",
        protectedActionExecuted: false,
        ...evidence(approval),
      });
    }
    return revoked;
  }

  private isExpired(value: { expiresAt: string }): boolean {
    return new Date(value.expiresAt).getTime() <= this.now();
  }

  private async recordApprovalExpired(approval: ApprovalRecord): Promise<void> {
    await this.audit.record({
      eventType: "approval.expired",
      humanId: approval.humanId,
      agentId: approval.agentId,
      runId: approval.runId,
      requestId: approval.requestId,
      action: approval.action,
      resourceId: approval.resourceId,
      decision: "deny",
      risk: "high",
      reasonCode: "approval_expired",
      approvalId: approval.id,
      capabilityId: null,
      status: "failure",
      durationMs: null,
      policyVersion: AGENTGATE_POLICY_VERSION,
      explanation: "The approval window expired before the protected action executed.",
      enforcementPoint: "ApprovalService",
      protectedActionExecuted: false,
      ...evidence(approval),
    });
  }
}

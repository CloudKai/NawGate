import { randomUUID } from "node:crypto";
import { AuditService } from "./audit-service.js";
import type { ApprovalRecord, AgentGateAction, CapabilityLease, HumanId } from "./types.js";
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
}

export type CapabilityConsumption =
  | { status: "consumed"; capability: CapabilityLease }
  | { status: "pending"; approval: ApprovalRecord }
  | {
      status: "denied";
      reasonCode: "approval_denied" | "approval_expired" | "capability_consumed" | "invalid_capability";
    };

export type ApprovalErrorCode =
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_NOT_OWNED"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_DENIED"
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
    left.resourceId === right.resourceId
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
    lease.resourceId === request.resourceId
  );
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
    });
    return outcome;
  }

  capabilityStatus(approvalId: string): "usable" | "expired" | "missing" {
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
    });
    return approval;
  }

  async consumeCapability(request: ApprovalRequest & { approvalId: string }): Promise<CapabilityConsumption> {
    let expiredApproval: ApprovalRecord | null = null;
    const outcome = await this.store.mutate<CapabilityConsumption>((database) => {
      const approval = database.approvals.find((candidate) => candidate.id === request.approvalId);
      if (!approval || !sameRequest(request, approval)) {
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
      if (approval.status === "consumed") {
        return { status: "denied", reasonCode: "capability_consumed" };
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
      });
    }
    return outcome;
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
    });
  }
}

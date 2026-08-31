import { randomUUID } from "node:crypto";
import type {
  NawGateAction,
  AuditDecision,
  AuditEvent,
  AuditEventType,
  AuditRisk,
  AuditStatus,
  HumanId,
  TeamId,
  TeamRole,
  ResourceClassification,
  ApprovalAuthorityRole,
  ApprovalDecision,
} from "./types.js";
import { NAWGATE_POLICY_VERSION } from "./types.js";
import { JsonStore } from "../store.js";

export interface AuditEventInput {
  eventType: AuditEventType;
  humanId: HumanId | null;
  agentId: string | null;
  runId: string | null;
  requestId: string | null;
  action: NawGateAction | null;
  resourceId: string | null;
  decision: AuditDecision | null;
  risk: AuditRisk | null;
  reasonCode: string | null;
  approvalId: string | null;
  capabilityId: string | null;
  status: AuditStatus;
  durationMs: number | null;
  policyVersion?: string | null;
  explanation?: string | null;
  enforcementPoint?: string | null;
  protectedActionExecuted?: boolean | null;
  grantId?: string | null;
  teamId?: TeamId | null;
  bundleVersion?: number | null;
  effectiveScope?: string[] | null;
  humanRole?: TeamRole | null;
  agentRole?: TeamRole | null;
  resourceClassification?: ResourceClassification | null;
  temporaryScope?: string[] | null;
  rejectedFieldNames?: string[] | null;
  riskVersion?: string | null;
  riskFactsDigest?: string | null;
  requiredApprovalCount?: number | null;
  requiredApprovalRoles?: ApprovalAuthorityRole[] | null;
  approvalDecisions?: ApprovalDecision[] | null;
}

export class AuditService {
  constructor(
    private readonly store: JsonStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async record(input: AuditEventInput): Promise<AuditEvent> {
    // Only identifiers already registered in trusted resource metadata are
    // useful audit evidence. Never persist caller-controlled unknown strings
    // (which could contain a runtime credential or protected payload).
    const safeResourceId = input.resourceId === null
      ? null
      : this.store
          .snapshot()
          .protectedResources.some((resource) => resource.id === input.resourceId)
        ? input.resourceId
        : "unknown";
    const event: AuditEvent = {
      id: randomUUID(),
      eventType: input.eventType,
      createdAt: this.now(),
      humanId: input.humanId,
      agentId: input.agentId,
      runId: input.runId,
      requestId: input.requestId,
      action: input.action,
      resourceId: safeResourceId,
      decision: input.decision,
      risk: input.risk,
      reasonCode: input.reasonCode,
      approvalId: input.approvalId,
      capabilityId: input.capabilityId,
      status: input.status,
      durationMs: input.durationMs,
      policyVersion:
        input.policyVersion ??
        (input.eventType.startsWith("policy.") ? NAWGATE_POLICY_VERSION : null),
      explanation: input.explanation ?? null,
      enforcementPoint: input.enforcementPoint ?? null,
      protectedActionExecuted: input.protectedActionExecuted ?? null,
      grantId: input.grantId ?? null,
      teamId: input.teamId ?? null,
      bundleVersion: input.bundleVersion ?? null,
      effectiveScope: input.effectiveScope ?? null,
      humanRole: input.humanRole ?? null,
      agentRole: input.agentRole ?? null,
      resourceClassification: input.resourceClassification ?? null,
      temporaryScope: input.temporaryScope ?? null,
      rejectedFieldNames: input.rejectedFieldNames ? [...input.rejectedFieldNames] : null,
      riskVersion: input.riskVersion ?? null,
      riskFactsDigest: input.riskFactsDigest ?? null,
      requiredApprovalCount: input.requiredApprovalCount ?? null,
      requiredApprovalRoles: input.requiredApprovalRoles ? [...input.requiredApprovalRoles] : null,
      approvalDecisions: input.approvalDecisions
        ? input.approvalDecisions.map((decision) => ({ ...decision }))
        : null,
    };
    await this.store.mutate((database) => {
      database.auditEvents.push(event);
    });
    return structuredClone(event);
  }

  list(agentId: string, runId?: string): AuditEvent[] {
    return this.store
      .snapshot()
      .auditEvents
      .filter(
        (event) =>
          event.agentId === agentId && (runId === undefined || event.runId === runId),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}

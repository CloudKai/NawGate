import { randomUUID } from "node:crypto";
import type {
  AgentGateAction,
  AuditDecision,
  AuditEvent,
  AuditEventType,
  AuditRisk,
  AuditStatus,
  HumanId,
  TeamId,
} from "./types.js";
import { AGENTGATE_POLICY_VERSION } from "./types.js";
import { JsonStore } from "../store.js";

export interface AuditEventInput {
  eventType: AuditEventType;
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
  policyVersion?: string | null;
  explanation?: string | null;
  enforcementPoint?: string | null;
  protectedActionExecuted?: boolean | null;
  grantId?: string | null;
  teamId?: TeamId | null;
  bundleVersion?: number | null;
  effectiveScope?: string[] | null;
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
      createdAt: this.now(),
      ...input,
      resourceId: safeResourceId,
      policyVersion:
        input.policyVersion ??
        (input.eventType.startsWith("policy.") ? AGENTGATE_POLICY_VERSION : null),
      explanation: input.explanation ?? null,
      enforcementPoint: input.enforcementPoint ?? null,
      protectedActionExecuted: input.protectedActionExecuted ?? null,
      grantId: input.grantId ?? null,
      teamId: input.teamId ?? null,
      bundleVersion: input.bundleVersion ?? null,
      effectiveScope: input.effectiveScope ?? null,
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

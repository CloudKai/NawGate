import { randomUUID } from "node:crypto";
import type {
  AgentGateAction,
  AuditDecision,
  AuditEvent,
  AuditEventType,
  AuditRisk,
  AuditStatus,
  HumanId,
} from "./types.js";
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
}

export class AuditService {
  constructor(
    private readonly store: JsonStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async record(input: AuditEventInput): Promise<AuditEvent> {
    // Only canonical resource identifiers are useful audit evidence. Never
    // persist caller-controlled unknown strings (which could contain a
    // runtime credential or protected payload).
    const safeResourceId = input.resourceId !== null &&
      /^(project-[ab]|staging|production)$/.test(input.resourceId)
      ? input.resourceId
      : input.resourceId === null
        ? null
        : "unknown";
    const event: AuditEvent = {
      id: randomUUID(),
      createdAt: this.now(),
      ...input,
      resourceId: safeResourceId,
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

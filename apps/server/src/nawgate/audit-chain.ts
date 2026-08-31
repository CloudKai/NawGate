import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import {
  AUDIT_HASH_ALGORITHM,
  AUDIT_INTEGRITY_VERSION,
  type AuditChainState,
  type AuditEvent,
  type AuditIntegrityReasonCode,
  type AuditIntegrityReport,
} from "./types.js";

export const AUDIT_GENESIS_HASH = "0".repeat(64);
const AUDIT_DOMAIN_SEPARATOR = `${AUDIT_INTEGRITY_VERSION}\n`;

const HASHED_EVENT_FIELDS = [
  "id",
  "eventType",
  "createdAt",
  "humanId",
  "agentId",
  "runId",
  "requestId",
  "action",
  "resourceId",
  "decision",
  "risk",
  "reasonCode",
  "approvalId",
  "capabilityId",
  "status",
  "durationMs",
  "policyVersion",
  "explanation",
  "enforcementPoint",
  "protectedActionExecuted",
  "grantId",
  "teamId",
  "bundleVersion",
  "effectiveScope",
  "humanRole",
  "agentRole",
  "resourceClassification",
  "temporaryScope",
  "rejectedFieldNames",
  "riskVersion",
  "riskFactsDigest",
  "requiredApprovalCount",
  "requiredApprovalRoles",
  "approvalDecisions",
] as const;

const PERSISTED_EVENT_FIELDS = new Set([
  ...HASHED_EVENT_FIELDS,
  "integrityVersion",
  "sequence",
  "previousHash",
  "eventHash",
]);

type ChainDatabase = {
  auditEvents: readonly AuditEvent[];
  auditChain?: AuditChainState | null;
};

export class AuditIntegrityError extends Error {
  constructor(message = "Audit integrity is broken; writes are disabled") {
    super(message);
    this.name = "AuditIntegrityError";
  }
}

export function emptyAuditChainState(): AuditChainState {
  return {
    version: AUDIT_INTEGRITY_VERSION,
    algorithm: AUDIT_HASH_ALGORITHM,
    headSequence: 0,
    headHash: null,
    legacyEventCount: 0,
    startedAt: null,
  };
}

function hashedEventEvidence(event: AuditEvent): Record<string, unknown> {
  return Object.fromEntries(
    HASHED_EVENT_FIELDS.map((field) => [field, event[field]]),
  );
}

export function auditEventHashInput(event: AuditEvent): Record<string, unknown> {
  return {
    integrityVersion: event.integrityVersion,
    sequence: event.sequence,
    previousHash: event.previousHash,
    event: hashedEventEvidence(event),
  };
}

export function hashAuditEvent(event: AuditEvent): string {
  const canonical = canonicalJson(auditEventHashInput(event));
  return createHash("sha256")
    .update(AUDIT_DOMAIN_SEPARATOR + canonical, "utf8")
    .digest("hex");
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isValidChainState(value: unknown): value is AuditChainState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  const expectedKeys = new Set([
    "version",
    "algorithm",
    "headSequence",
    "headHash",
    "legacyEventCount",
    "startedAt",
  ]);
  return (
    Object.keys(state).length === expectedKeys.size &&
    Object.keys(state).every((key) => expectedKeys.has(key)) &&
    state.version === AUDIT_INTEGRITY_VERSION &&
    state.algorithm === AUDIT_HASH_ALGORITHM &&
    typeof state.headSequence === "number" &&
    Number.isInteger(state.headSequence) &&
    state.headSequence >= 0 &&
    (state.headHash === null || isHash(state.headHash)) &&
    typeof state.legacyEventCount === "number" &&
    Number.isInteger(state.legacyEventCount) &&
    state.legacyEventCount >= 0 &&
    (state.startedAt === null || isDate(state.startedAt))
  );
}

function eventHasExactPersistedShape(event: AuditEvent): boolean {
  const keys = Object.keys(event);
  return keys.length === PERSISTED_EVENT_FIELDS.size && keys.every((key) => PERSISTED_EVENT_FIELDS.has(key));
}

function report(
  status: AuditIntegrityReport["status"],
  reasonCode: AuditIntegrityReasonCode,
  state: AuditChainState | null,
  chainedEventCount: number,
  legacyEventCount: number,
  firstBrokenSequence: number | null,
  verifiedAt: string,
): AuditIntegrityReport {
  return {
    status,
    integrityVersion: AUDIT_INTEGRITY_VERSION,
    verifiedAt,
    headSequence: state?.headSequence ?? 0,
    chainedEventCount,
    unverifiedLegacyEventCount: state?.legacyEventCount ?? legacyEventCount,
    reasonCode,
    firstBrokenSequence,
  };
}

/**
 * Verify the persisted safe evidence as a single global chain. Legacy events
 * are intentionally retained as an unverified prefix and are never
 * retroactively assigned trust.
 */
export function verifyAuditChain(
  database: ChainDatabase,
  verifiedAt = new Date().toISOString(),
): AuditIntegrityReport {
  const state = database.auditChain;
  if (!Array.isArray(database.auditEvents) || !isValidChainState(state)) {
    return report("broken", "invalid_chain_metadata", isValidChainState(state) ? state : null, 0, 0, null, verifiedAt);
  }

  let legacyEventCount = 0;
  let chainedEventCount = 0;
  let chainStarted = false;
  let firstChainedEventCreatedAt: string | null = null;
  let previousHash = AUDIT_GENESIS_HASH;
  const seenSequences = new Set<number>();

  for (const event of database.auditEvents) {
    if (!event || !eventHasExactPersistedShape(event)) {
      return report("broken", "invalid_event_hash", state, chainedEventCount, legacyEventCount, null, verifiedAt);
    }

    const isLegacy =
      event.integrityVersion === null &&
      event.sequence === null &&
      event.previousHash === null &&
      event.eventHash === null;
    if (isLegacy) {
      if (chainStarted) {
        return report("broken", "unexpected_unchained_event", state, chainedEventCount, legacyEventCount, null, verifiedAt);
      }
      legacyEventCount += 1;
      continue;
    }

    chainStarted = true;
    chainedEventCount += 1;
    firstChainedEventCreatedAt ??= event.createdAt;
    if (typeof event.sequence !== "number" || !Number.isInteger(event.sequence) || event.sequence < 1) {
      return report("broken", "invalid_sequence", state, chainedEventCount, legacyEventCount, event.sequence ?? null, verifiedAt);
    }
    if (seenSequences.has(event.sequence)) {
      return report("broken", "duplicate_sequence", state, chainedEventCount, legacyEventCount, event.sequence, verifiedAt);
    }
    seenSequences.add(event.sequence);
    if (event.sequence !== chainedEventCount) {
      return report("broken", "invalid_sequence", state, chainedEventCount, legacyEventCount, event.sequence, verifiedAt);
    }
    if (
      event.integrityVersion !== AUDIT_INTEGRITY_VERSION ||
      event.previousHash !== previousHash
    ) {
      return report("broken", "invalid_previous_hash", state, chainedEventCount, legacyEventCount, event.sequence, verifiedAt);
    }
    if (!isHash(event.eventHash)) {
      return report("broken", "invalid_event_hash", state, chainedEventCount, legacyEventCount, event.sequence, verifiedAt);
    }
    let expectedHash: string;
    try {
      expectedHash = hashAuditEvent(event);
    } catch {
      return report("broken", "invalid_event_hash", state, chainedEventCount, legacyEventCount, event.sequence, verifiedAt);
    }
    if (event.eventHash !== expectedHash) {
      return report("broken", "invalid_event_hash", state, chainedEventCount, legacyEventCount, event.sequence, verifiedAt);
    }
    previousHash = event.eventHash;
  }

  if (state.legacyEventCount !== legacyEventCount) {
    return report("broken", "invalid_chain_metadata", state, chainedEventCount, legacyEventCount, null, verifiedAt);
  }
  if (chainedEventCount === 0) {
    if (state.headSequence !== 0 || state.headHash !== null || state.startedAt !== null) {
      return report("broken", "head_mismatch", state, chainedEventCount, legacyEventCount, null, verifiedAt);
    }
    return report("not_yet_verified", "no_chained_events", state, 0, legacyEventCount, null, verifiedAt);
  }
  if (
    state.headSequence !== chainedEventCount ||
    state.headHash !== previousHash ||
    state.startedAt === null ||
    state.startedAt !== firstChainedEventCreatedAt
  ) {
    return report(
      "broken",
      state.startedAt !== firstChainedEventCreatedAt ? "invalid_chain_metadata" : "head_mismatch",
      state,
      chainedEventCount,
      legacyEventCount,
      state.headSequence,
      verifiedAt,
    );
  }
  return report("verified", "chain_valid", state, chainedEventCount, legacyEventCount, null, verifiedAt);
}

export function appendAuditEvent(
  database: ChainDatabase & { auditEvents: AuditEvent[]; auditChain: AuditChainState },
  event: Omit<AuditEvent, "integrityVersion" | "sequence" | "previousHash" | "eventHash">,
  startedAt: string,
): AuditEvent {
  const current = verifyAuditChain(database);
  if (current.status === "broken") throw new AuditIntegrityError();
  const sequence = database.auditChain.headSequence + 1;
  const finalized: AuditEvent = {
    ...event,
    integrityVersion: AUDIT_INTEGRITY_VERSION,
    sequence,
    previousHash: database.auditChain.headHash ?? AUDIT_GENESIS_HASH,
    eventHash: null,
  };
  finalized.eventHash = hashAuditEvent(finalized);
  database.auditEvents.push(finalized);
  database.auditChain.headSequence = sequence;
  database.auditChain.headHash = finalized.eventHash;
  database.auditChain.startedAt ??= startedAt;
  return finalized;
}

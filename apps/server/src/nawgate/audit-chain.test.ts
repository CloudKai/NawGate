import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditIntegrityError } from "./audit-chain.js";
import { AuditService, type AuditEventInput } from "./audit-service.js";
import { AUDIT_INTEGRITY_VERSION } from "./types.js";
import { JsonStore } from "../store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function input(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    eventType: "policy.deny",
    humanId: "user-a",
    agentId: "agent-a",
    runId: "run-a",
    requestId: "request-a",
    action: "resource.read",
    resourceId: "project-a",
    decision: "deny",
    risk: "low",
    reasonCode: "invalid_context",
    approvalId: null,
    capabilityId: null,
    status: "failure",
    durationMs: 2,
    policyVersion: "bouncer-v5",
    explanation: "Safe denial",
    enforcementPoint: "RuntimeGateway",
    protectedActionExecuted: false,
    ...overrides,
  };
}

async function makeStore() {
  const root = await mkdtemp(path.join(tmpdir(), "nawgate-audit-chain-test-"));
  temporaryDirectories.push(root);
  const filePath = path.join(root, "launchpad.json");
  const store = new JsonStore(filePath);
  await store.initialize();
  return { store, filePath };
}

describe("tamper-evident audit chain", () => {
  it("redacts before hashing and links events to the persisted head", async () => {
    const { store } = await makeStore();
    const audit = new AuditService(store);
    const first = await audit.record(input({
      reasonCode: "token sk-abcdef12345678901234567890",
      explanation: "Bearer secret-token-value",
    }));
    const second = await audit.record(input({ requestId: "request-b" }));

    expect(first.integrityVersion).toBe(AUDIT_INTEGRITY_VERSION);
    expect(first.sequence).toBe(1);
    expect(first.previousHash).toBe("0".repeat(64));
    expect(first.eventHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.reasonCode).not.toContain("sk-abcdef");
    expect(first.explanation).not.toContain("secret-token-value");
    expect(second.sequence).toBe(2);
    expect(second.previousHash).toBe(first.eventHash);
    expect(second.eventHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await audit.integrity()).status).toBe("verified");
    expect(JSON.stringify(await audit.integrity())).not.toContain("secret-token-value");
  });

  it("starts as not yet verified before the first chained event", async () => {
    const { store } = await makeStore();

    await expect(store.verifyAuditIntegrity()).resolves.toMatchObject({
      status: "not_yet_verified",
      reasonCode: "no_chained_events",
      headSequence: 0,
      chainedEventCount: 0,
    });
  });

  it("allocates contiguous global sequence numbers under concurrent records and survives restart", async () => {
    const { store, filePath } = await makeStore();
    const audit = new AuditService(store);
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        audit.record(input({ requestId: `request-${index}` })),
      ),
    );
    const events = store.snapshot().auditEvents;
    expect(events.map((event) => event.sequence).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
    expect((await store.verifyAuditIntegrity()).status).toBe("verified");

    const restarted = new JsonStore(filePath);
    await restarted.initialize();
    expect((await restarted.verifyAuditIntegrity()).status).toBe("verified");
    expect(restarted.snapshot().auditChain.headSequence).toBe(50);
  });

  it("detects field tampering and refuses to overwrite the damaged file", async () => {
    const { store, filePath } = await makeStore();
    const audit = new AuditService(store);
    await audit.record(input());
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
      auditEvents: Array<Record<string, unknown>>;
    };
    persisted.auditEvents[0]!.explanation = "tampered";
    await writeFile(filePath, JSON.stringify(persisted, null, 2) + "\n", "utf8");
    const damagedContents = await readFile(filePath, "utf8");

    await expect(store.verifyAuditIntegrity()).resolves.toMatchObject({
      status: "broken",
      reasonCode: "invalid_event_hash",
      firstBrokenSequence: 1,
    });
    await expect(store.mutate((database) => {
      database.messages.push({
        id: "message-after-tamper",
        agentId: "agent-a",
        runId: "run-a",
        role: "user",
        content: "must not persist",
        createdAt: new Date().toISOString(),
      });
    })).rejects.toBeInstanceOf(AuditIntegrityError);
    expect(await readFile(filePath, "utf8")).toBe(damagedContents);
  });

  it("detects tail deletion through the persisted head and preserves legacy honesty", async () => {
    const { store, filePath } = await makeStore();
    const audit = new AuditService(store);
    await audit.record(input());
    await audit.record(input({ requestId: "request-b" }));
    const current = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown> & {
      auditEvents: unknown[];
    };
    current.auditEvents.pop();
    await writeFile(filePath, JSON.stringify(current, null, 2) + "\n", "utf8");
    expect(await store.verifyAuditIntegrity()).toMatchObject({
      status: "broken",
      reasonCode: "head_mismatch",
    });

    const legacyRoot = await mkdtemp(path.join(tmpdir(), "nawgate-legacy-audit-test-"));
    temporaryDirectories.push(legacyRoot);
    const legacyPath = path.join(legacyRoot, "launchpad.json");
    const cleanStore = new JsonStore(legacyPath);
    await cleanStore.initialize();
    const legacyDatabase = cleanStore.snapshot();
    await writeFile(legacyPath, JSON.stringify({
      ...legacyDatabase,
      version: 7,
      auditEvents: [{
        id: "legacy-event",
        eventType: "policy.deny",
        createdAt: "2026-08-30T00:00:00.000Z",
        humanId: "user-a",
        agentId: "agent-a",
        runId: "run-a",
        requestId: "legacy-request",
        action: "resource.read",
        resourceId: "project-a",
        decision: "deny",
        risk: "low",
        reasonCode: "legacy",
        approvalId: null,
        capabilityId: null,
        status: "failure",
        durationMs: 1,
      }],
    }, null, 2), "utf8");
    await cleanStore.initialize();
    expect(await cleanStore.verifyAuditIntegrity()).toMatchObject({
      status: "not_yet_verified",
      unverifiedLegacyEventCount: 1,
    });
    const legacyAudit = new AuditService(cleanStore);
    const postMigration = await legacyAudit.record(input({ requestId: "post-migration" }));
    expect(postMigration.sequence).toBe(1);
    expect(await cleanStore.verifyAuditIntegrity()).toMatchObject({
      status: "verified",
      unverifiedLegacyEventCount: 1,
      chainedEventCount: 1,
    });
  });

  it.each([
    ["previous-link", "invalid_previous_hash", (events: Array<Record<string, unknown>>, state: Record<string, unknown>) => {
      events[1]!.previousHash = "1".repeat(64);
    }],
    ["event-hash", "invalid_event_hash", (events: Array<Record<string, unknown>>, state: Record<string, unknown>) => {
      events[0]!.eventHash = "1".repeat(64);
    }],
    ["reordered-events", "invalid_sequence", (events: Array<Record<string, unknown>>, state: Record<string, unknown>) => {
      events.reverse();
    }],
    ["inserted-event", "invalid_previous_hash", (events: Array<Record<string, unknown>>, state: Record<string, unknown>) => {
      events.splice(1, 0, { ...events[0], id: "forged-event", sequence: 2 });
    }],
    ["duplicate-sequence", "duplicate_sequence", (events: Array<Record<string, unknown>>, state: Record<string, unknown>) => {
      events[1]!.sequence = 1;
    }],
    ["deleted-middle-event", "invalid_sequence", (events: Array<Record<string, unknown>>, state: Record<string, unknown>) => {
      events.splice(1, 1);
    }],
    ["head-metadata", "head_mismatch", (events: Array<Record<string, unknown>>, state: Record<string, unknown>) => {
      state.headSequence = 99;
    }],
    ["started-at-metadata", "invalid_chain_metadata", (events: Array<Record<string, unknown>>, state: Record<string, unknown>) => {
      state.startedAt = "2026-01-01T00:00:00.000Z";
    }],
    ["metadata-shape", "invalid_chain_metadata", (events: Array<Record<string, unknown>>, state: Record<string, unknown>) => {
      state.unexpected = true;
    }],
    ["deleted-event-field", "invalid_event_hash", (events: Array<Record<string, unknown>>, state: Record<string, unknown>) => {
      delete events[0]!.explanation;
    }],
    ["unchained-after-start", "unexpected_unchained_event", (events: Array<Record<string, unknown>>, state: Record<string, unknown>) => {
      events.push({
        ...events[0],
        id: "legacy-after-chain",
        integrityVersion: null,
        sequence: null,
        previousHash: null,
        eventHash: null,
      });
    }],
  ] as const)("detects %s corruption", async (_name, reasonCode, mutate) => {
    const { store, filePath } = await makeStore();
    const audit = new AuditService(store);
    await audit.record(input({ requestId: "request-1" }));
    await audit.record(input({ requestId: "request-2" }));
    await audit.record(input({ requestId: "request-3" }));
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
      auditEvents: Array<Record<string, unknown>>;
      auditChain: Record<string, unknown>;
    };
    mutate(persisted.auditEvents, persisted.auditChain);
    await writeFile(filePath, JSON.stringify(persisted, null, 2) + "\n", "utf8");
    expect(await store.verifyAuditIntegrity()).toMatchObject({
      status: "broken",
      reasonCode,
    });
  });
});

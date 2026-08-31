import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getReplay,
  listReplays,
  recordFlightData,
  type ReplayPayload,
} from "./flight-recorder.js";

describe("Flight Data Recorder Service", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "flight-recorder-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("persists and retrieves sanitized flight data", async () => {
    const payload: ReplayPayload = {
      runId: "run-123",
      agentId: "agent-abc",
      ownerUserId: "user-a",
      prompt: "Deploy to production with key sk-abcdef12345678901234567890",
      output: "Deployed successfully. Session token: Bearer my-session-token-secret-1234",
      error: null,
      status: "completed",
      usage: { inputTokens: 50, outputTokens: 25 },
      startedAt: "2026-08-30T10:00:00.000Z",
      completedAt: "2026-08-30T10:00:02.500Z",
      durationMs: 2500,
      auditEvents: [
        {
          id: "audit-1",
          eventType: "policy.allow",
          createdAt: "2026-08-30T10:00:01.000Z",
          humanId: "user-a",
          agentId: "agent-abc",
          runId: "run-123",
          requestId: "req-1",
          action: "resource.read",
          resourceId: "project-a",
          decision: "allow",
          risk: "low",
          reasonCode: "owned_resource_read",
          approvalId: null,
          capabilityId: null,
          status: "success",
          durationMs: 12,
          policyVersion: "bouncer-v1",
          explanation: "Access allowed for user email admin@launchpad.io",
          enforcementPoint: "RuntimeGateway",
          protectedActionExecuted: false,
        },
      ],
    };

    await recordFlightData(payload, tempDir);

    const retrieved = await getReplay("agent-abc", "run-123", tempDir);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.runId).toBe("run-123");
    expect(retrieved?.agentId).toBe("agent-abc");
    // Verifies DLP proxy sanitization was applied before writing to disk
    expect(retrieved?.prompt).toBe("Deploy to production with key [REDACTED_OPENAI_KEY]");
    expect(retrieved?.output).toBe("Deployed successfully. Session token: Bearer [REDACTED_TOKEN]");
    expect(retrieved?.auditEvents[0]?.explanation).toBe("Access allowed for user email [REDACTED_EMAIL]");
    expect(retrieved?.usage).toEqual({ inputTokens: 50, outputTokens: 25 });
    expect(retrieved?.durationMs).toBe(2500);
  });

  it("returns null for non-existent replay", async () => {
    const retrieved = await getReplay("non-existent", "run-missing", tempDir);
    expect(retrieved).toBeNull();
  });

  it("lists replay summaries in descending order of completion time", async () => {
    const base: Omit<ReplayPayload, "runId" | "completedAt"> = {
      agentId: "agent-xyz",
      ownerUserId: "user-a",
      prompt: "test",
      output: "ok",
      error: null,
      status: "completed",
      usage: null,
      startedAt: "2026-08-30T10:00:00.000Z",
      durationMs: 1000,
      auditEvents: [],
    };

    await recordFlightData(
      { ...base, runId: "run-1", completedAt: "2026-08-30T10:00:01.000Z" },
      tempDir,
    );
    await recordFlightData(
      { ...base, runId: "run-2", completedAt: "2026-08-30T10:00:05.000Z" },
      tempDir,
    );

    const list = await listReplays("agent-xyz", tempDir);
    expect(list).toHaveLength(2);
    expect(list[0].runId).toBe("run-2");
    expect(list[1].runId).toBe("run-1");
  });
});

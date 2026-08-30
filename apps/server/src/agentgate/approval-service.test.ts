import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalService, type ApprovalRequest } from "./approval-service.js";
import { AuditService } from "./audit-service.js";
import { JsonStore } from "../store.js";

const temporaryDirectories: string[] = [];
const request: ApprovalRequest = {
  humanId: "user-a",
  agentId: "agent-a",
  runId: "run-a",
  requestId: "request-a",
  action: "deploy.production",
  resourceId: "production",
  reasonCode: "production_deploy_requires_owner_approval",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeServices(now: () => number = Date.now, ttlMs = 300_000) {
  const root = await mkdtemp(path.join(tmpdir(), "agentgate-approval-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const audit = new AuditService(store, () => new Date(now()).toISOString());
  const approvals = new ApprovalService(store, audit, now, ttlMs);
  return { approvals, audit };
}

describe("ApprovalService", () => {
  it("creates one pending approval and issues an exact one-use capability", async () => {
    const { approvals, audit } = await makeServices();
    const pending = await approvals.getOrCreate(request);
    expect(pending.status).toBe("pending");
    expect((await approvals.getOrCreate(request)).id).toBe(pending.id);

    const { approval, capability } = await approvals.approve(pending.id, "user-a");
    expect(approval.status).toBe("approved");
    expect(capability.remainingUses).toBe(1);

    const consumed = await approvals.consumeCapability({ ...request, approvalId: pending.id });
    expect(consumed.status).toBe("consumed");
    if (consumed.status === "consumed") expect(consumed.capability.remainingUses).toBe(0);
    await expect(
      approvals.consumeCapability({ ...request, approvalId: pending.id }),
    ).resolves.toEqual({ status: "denied", reasonCode: "capability_consumed" });

    const events = JSON.stringify(audit.list("agent-a"));
    expect(events).toContain("approval.approved");
    expect(events).toContain("capability.issued");
    expect(events).toContain("capability.consumed");
    expect(events).not.toContain("TEST_RUNTIME_SECRET_DO_NOT_LOG");
  });

  it("only lets the bound owner approve or deny", async () => {
    const { approvals } = await makeServices();
    const pending = await approvals.getOrCreate(request);

    await expect(approvals.approve(pending.id, "user-b")).rejects.toMatchObject({
      code: "APPROVAL_NOT_OWNED",
    });
    await expect(approvals.deny(pending.id, "user-b")).rejects.toMatchObject({
      code: "APPROVAL_NOT_OWNED",
    });
    await expect(approvals.deny(pending.id, "user-a")).resolves.toMatchObject({ status: "denied" });
  });

  it("rejects an exact-binding mismatch and expires leases", async () => {
    let current = 1_000;
    const { approvals, audit } = await makeServices(() => current, 100);
    const pending = await approvals.getOrCreate(request);
    const approved = await approvals.approve(pending.id, "user-a");

    await expect(
      approvals.consumeCapability({ ...request, approvalId: pending.id, resourceId: "staging" }),
    ).resolves.toEqual({ status: "denied", reasonCode: "invalid_capability" });
    current = 1_100;
    await expect(
      approvals.consumeCapability({ ...request, approvalId: pending.id }),
    ).resolves.toEqual({ status: "denied", reasonCode: "approval_expired" });
    expect(approved.capability.remainingUses).toBe(1);
    expect(audit.list("agent-a").map((event) => event.eventType)).toContain("approval.expired");
  });

  it("serializes concurrent approval decisions", async () => {
    const { approvals } = await makeServices();
    const pending = await approvals.getOrCreate(request);
    const outcomes = await Promise.allSettled([
      approvals.approve(pending.id, "user-a"),
      approvals.approve(pending.id, "user-a"),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  });

  it("does not recreate a denied or expired approval for the same request", async () => {
    let current = 1_000;
    const { approvals } = await makeServices(() => current, 100);
    const denied = await approvals.getOrCreate(request);
    await approvals.deny(denied.id, "user-a");
    await expect(approvals.getOrCreate(request)).resolves.toMatchObject({
      id: denied.id,
      status: "denied",
    });

    const expiredRequest = { ...request, requestId: "request-expired" };
    const expired = await approvals.getOrCreate(expiredRequest);
    current = 1_100;
    await expect(approvals.getOrCreate(expiredRequest)).resolves.toMatchObject({
      id: expired.id,
      status: "expired",
    });
    expect(await approvals.list("user-a")).toHaveLength(2);
  });
});

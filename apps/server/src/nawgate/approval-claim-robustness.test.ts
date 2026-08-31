import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalService, type ApprovalRequest } from "./approval-service.js";
import { AuditService } from "./audit-service.js";
import { canonicalJson, canonicalPayloadDigest } from "./canonical-json.js";
import { ProtectedResourceService } from "./protected-resource-service.js";
import { JsonStore } from "../store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    humanId: "user-a",
    agentId: "agent-a",
    runId: "run-a",
    requestId: "request-a",
    action: "deploy.production",
    resourceId: "production",
    reasonCode: "production_deploy_requires_owner_approval",
    payload: { version: "release-1", flags: { safe: true } },
    destination: "production-primary",
    policyRevision: "bouncer-v4",
    resourceRevision: 1,
    ...overrides,
  };
}

async function makeServices(now: () => number = Date.now, ttlMs = 300_000) {
  const root = await mkdtemp(path.join(tmpdir(), "nawgate-claim-test-"));
  temporaryDirectories.push(root);
  const filePath = path.join(root, "db.json");
  const store = new JsonStore(filePath);
  await store.initialize();
  const audit = new AuditService(store, () => new Date(now()).toISOString());
  const approvals = new ApprovalService(store, audit, now, ttlMs);
  return { root, filePath, store, audit, approvals };
}

describe("durable approval claims", () => {
  it("uses one deterministic canonical JSON digest and distinguishes a one-character payload change", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalPayloadDigest({ value: "a" })).not.toBe(
      canonicalPayloadDigest({ value: "b" }),
    );
  });

  it("reconstructs a usable claim after service restart without persisting payload or bearer material", async () => {
    const first = await makeServices();
    const pending = await first.approvals.getOrCreate(request({ payload: { secret: "DO_NOT_STORE" } }));
    await first.approvals.approve(pending.id, "user-a");
    const persisted = JSON.parse(await readFile(first.filePath, "utf8")) as {
      approvals: unknown[];
      capabilityClaims: unknown[];
    };
    expect(persisted.capabilityClaims).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain("DO_NOT_STORE");
    expect(JSON.stringify(persisted)).not.toContain("TEST_RUNTIME_SECRET_DO_NOT_LOG");

    const restartedStore = new JsonStore(first.filePath);
    await restartedStore.initialize();
    const restartedAudit = new AuditService(restartedStore);
    const restartedApprovals = new ApprovalService(restartedStore, restartedAudit);
    await expect(
      restartedApprovals.consumeCapability({
        ...request({ payload: { secret: "DO_NOT_STORE" } }),
        approvalId: pending.id,
      }),
    ).resolves.toMatchObject({ status: "consumed" });
    expect(restartedStore.snapshot().capabilityClaims[0]?.remainingUses).toBe(0);
  });

  it("atomically permits only one concurrent consumer and durably records the terminal use", async () => {
    const { approvals, store } = await makeServices();
    const pending = await approvals.getOrCreate(request());
    await approvals.approve(pending.id, "user-a");
    const outcomes = await Promise.all([
      approvals.consumeCapability({ ...request(), approvalId: pending.id }),
      approvals.consumeCapability({ ...request(), approvalId: pending.id }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "consumed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "denied")).toEqual([
      { status: "denied", reasonCode: "capability_consumed" },
    ]);
    expect(store.snapshot().approvals.find((approval) => approval.id === pending.id)?.status).toBe("consumed");
    expect(store.snapshot().capabilityClaims.find((claim) => claim.approvalId === pending.id)?.remainingUses).toBe(0);
  });

  it("fails closed for payload, destination, revision, and identity/action/resource/request substitution", async () => {
    const { approvals } = await makeServices();
    const original = request();
    const pending = await approvals.getOrCreate(original);
    await approvals.approve(pending.id, "user-a");
    const mutations: Partial<ApprovalRequest>[] = [
      { payload: { version: "release-2", flags: { safe: true } } },
      { destination: "production-secondary" },
      { policyRevision: "bouncer-v5" },
      { resourceRevision: 2 },
      { humanId: "user-b" },
      { agentId: "agent-b" },
      { runId: "run-b" },
      { requestId: "request-b" },
      { action: "deploy.staging" },
      { resourceId: "staging" },
    ];
    for (const mutation of mutations) {
      await expect(
        approvals.consumeCapability({ ...original, ...mutation, approvalId: pending.id } as ApprovalRequest & { approvalId: string }),
      ).resolves.toEqual({ status: "denied", reasonCode: "invalid_capability" });
    }
    await expect(
      approvals.consumeCapability({ ...original, approvalId: pending.id }),
    ).resolves.toMatchObject({ status: "consumed" });
  });

  it("invalidates claims on expiry, Run/grant revocation, and resource revision revocation", async () => {
    let current = 1_000;
    const { approvals, store } = await makeServices(() => current, 100);
    const expired = await approvals.getOrCreate(request({ requestId: "request-expired" }));
    await approvals.approve(expired.id, "user-a");
    current = 1_100;
    await expect(
      approvals.consumeCapability({ ...request({ requestId: "request-expired" }), approvalId: expired.id }),
    ).resolves.toEqual({ status: "denied", reasonCode: "approval_expired" });

    current = 2_000;
    const runRevoked = await approvals.getOrCreate(request({ requestId: "request-run-revoked" }));
    await approvals.approve(runRevoked.id, "user-a");
    await approvals.revokeForRun("run-a");
    await expect(
      approvals.consumeCapability({ ...request({ requestId: "request-run-revoked" }), approvalId: runRevoked.id }),
    ).resolves.toEqual({ status: "denied", reasonCode: "capability_revoked" });

    const grantRevoked = await approvals.getOrCreate(request({
      requestId: "request-grant-revoked",
      grantId: "grant-alpha",
      teamId: "team-alpha",
      bundleVersion: 1,
    }));
    await approvals.approve(grantRevoked.id, "user-a");
    await approvals.revokeForGrant("grant-alpha");
    await expect(
      approvals.consumeCapability({
        ...request({ requestId: "request-grant-revoked", grantId: "grant-alpha", teamId: "team-alpha", bundleVersion: 1 }),
        approvalId: grantRevoked.id,
      }),
    ).resolves.toEqual({ status: "denied", reasonCode: "capability_revoked" });

    const resourceRevoked = await approvals.getOrCreate(request({ requestId: "request-resource-revoked" }));
    await approvals.approve(resourceRevoked.id, "user-a");
    const resources = new ProtectedResourceService(store, approvals);
    await expect(resources.bumpRevision("production")).resolves.toMatchObject({ revision: 2 });
    await expect(
      approvals.consumeCapability({ ...request({ requestId: "request-resource-revoked" }), approvalId: resourceRevoked.id }),
    ).resolves.toEqual({ status: "denied", reasonCode: "capability_revoked" });
  });

  it("terminalizes old unbound approvals during v4 to v5 migration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nawgate-claim-migration-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    await writeFile(filePath, JSON.stringify({
      version: 4,
      agents: [],
      messages: [],
      runs: [],
      approvals: [{
        id: "00000000-0000-4000-8000-000000000010",
        humanId: "user-a",
        agentId: "agent-a",
        runId: "run-a",
        requestId: "request-a",
        action: "deploy.production",
        resourceId: "production",
        risk: "high",
        reasonCode: "production_deploy_requires_owner_approval",
        status: "approved",
        createdAt: "2026-08-30T00:00:00.000Z",
        decidedAt: "2026-08-30T00:00:01.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }],
      auditEvents: [],
      protectedResources: [],
      deploymentStates: [],
      actionExecutions: [],
      teamMemberships: [],
      agentTeamGrants: [],
    }), "utf8");
    const store = new JsonStore(filePath);
    await store.initialize();
    expect(store.snapshot().version).toBe(7);
    expect(store.snapshot().capabilityClaims).toEqual([]);
    expect(store.snapshot().approvals[0]).toMatchObject({ status: "revoked", reasonCode: "legacy_unbound_approval" });
  });

  it("terminalizes stale destination claims during v5 to v6 restart migration", async () => {
    const first = await makeServices();
    const contentRequest = request({
      action: "content.publish",
      resourceId: "asset-user-a-video-1",
      reasonCode: "content_publish_requires_owner_approval",
      payload: {
        purpose: "creator_requested_publish",
        organizationId: "org-user-a",
        businessCenterId: "business-center-user-a",
        accountId: "account-user-a",
        assetId: "asset-user-a-video-1",
        contentVersion: "v1",
      },
      destination: "tiktok-account:brand-sg",
      destinationRevision: 1,
    });
    const pending = await first.approvals.getOrCreate({
      ...contentRequest,
      requestId: "request-destination-restart-pending",
    });
    const approved = await first.approvals.getOrCreate({
      ...contentRequest,
      requestId: "request-destination-restart-approved",
    });
    await first.approvals.approve(approved.id, "user-a");
    await first.store.mutate((database) => {
      const destination = database.registeredDestinations.find(
        (candidate) => candidate.id === "tiktok-account:brand-sg",
      );
      if (!destination) throw new Error("Expected destination");
      destination.revision = 2;
    });

    const restartedStore = new JsonStore(first.filePath);
    await restartedStore.initialize();
    expect(restartedStore.snapshot().approvals).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pending.id, status: "revoked", reasonCode: "destination_revision_changed" }),
      expect.objectContaining({ id: approved.id, status: "revoked", reasonCode: "destination_revision_changed" }),
    ]));
    expect(restartedStore.snapshot().capabilityClaims).toEqual([
      expect.objectContaining({ approvalId: approved.id, remainingUses: 0 }),
    ]);
  });
});

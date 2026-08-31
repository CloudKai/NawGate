import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalAuthorityService } from "./approval-authority-service.js";
import { ApprovalService } from "./approval-service.js";
import { AuditService } from "./audit-service.js";
import { DestinationCatalogueService } from "./destination-catalogue.js";
import { LocalDestinationAdapter } from "./local-destination-adapter.js";
import { DeterministicPolicyEngine } from "./policy-engine.js";
import { ProtectedResourceService } from "./protected-resource-service.js";
import { RuntimeGateway } from "./runtime-gateway.js";
import { ServerSideCredentialBroker } from "./destination-broker.js";
import { JsonStore, migrateDatabase } from "../store.js";

const temporaryDirectories: string[] = [];

function contentPayload(overrides: Record<string, unknown> = {}) {
  return {
    purpose: "safety_moderation",
    organizationId: "org-user-a",
    businessCenterId: "business-center-user-a",
    accountId: "account-user-a",
    assetId: "asset-user-a-video-1",
    contentVersion: "v1",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeServices() {
  const root = await mkdtemp(path.join(tmpdir(), "nawgate-phase5-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const audit = new AuditService(store);
  const approvals = new ApprovalService(store, audit);
  const destinations = new DestinationCatalogueService(store, approvals);
  const resources = new ProtectedResourceService(
    store,
    approvals,
    new LocalDestinationAdapter(store, destinations, new ServerSideCredentialBroker()),
  );
  return {
    store,
    audit,
    approvals,
    authorities: new ApprovalAuthorityService(store, approvals, audit),
    resources,
    gateway: new RuntimeGateway(
      new DeterministicPolicyEngine(),
      resources,
      audit,
      approvals,
      store,
      undefined,
      undefined,
      undefined,
      destinations,
    ),
  };
}

describe("critical risk dual control", () => {
  it("requires distinct owner and independent reviewer approvals and consumes once", async () => {
    const { gateway, approvals, resources, store, authorities } = await makeServices();
    const context = { humanId: "user-a" as const, agentId: "agent-a", runId: "run-critical" };
    const request = {
      requestId: "request-critical-publish",
      action: "content.publish" as const,
      resourceId: "asset-user-a-video-2",
      destination: "tiktok-account:brand-sg",
      payload: contentPayload({
        purpose: "creator_requested_publish",
        assetId: "asset-user-a-video-2",
      }),
    };

    const pending = await gateway.execute(context, request);
    expect(pending).toMatchObject({
      status: "approval_required",
      risk: "critical",
      requiredApprovalCount: 2,
      requiredApprovalRoles: ["owner", "independent_reviewer"],
    });
    if (pending.status !== "approval_required") throw new Error("Expected critical approval");

    await expect(approvals.approve(pending.approvalId, "user-c")).rejects.toMatchObject({
      code: "APPROVAL_NOT_OWNED",
    });
    await expect(approvals.approve(pending.approvalId, "user-b")).rejects.toMatchObject({
      code: "APPROVAL_NOT_OWNED",
    });
    const first = await approvals.approve(pending.approvalId, "user-a");
    expect(first.capability).toBeNull();
    expect(first.approval).toMatchObject({ status: "pending", approvalDecisions: [
      expect.objectContaining({ humanId: "user-a", role: "owner", decision: "approve" }),
    ] });
    expect(store.snapshot().capabilityClaims).toHaveLength(0);

    const final = await approvals.approve(pending.approvalId, "user-c");
    expect(final.capability).toMatchObject({
      risk: "critical",
      remainingUses: 1,
      requiredApprovalCount: 2,
      approvalDecisions: [
        expect.objectContaining({ humanId: "user-a", role: "owner" }),
        expect.objectContaining({ humanId: "user-c", role: "independent_reviewer" }),
      ],
    });
    expect(store.snapshot().capabilityClaims).toHaveLength(1);

    const completed = await gateway.execute(context, { ...request, approvalId: pending.approvalId });
    expect(completed).toMatchObject({ status: "success" });
    expect(resources.getExecutionCount("content.publish", "asset-user-a-video-2")).toBe(1);
    await expect(gateway.execute(context, {
      ...request,
      requestId: "request-critical-replay",
      approvalId: pending.approvalId,
    })).resolves.toMatchObject({ status: "denied", reasonCode: "capability_consumed" });

    expect(authorities.resolveEligible({
      humanId: "user-c",
      organizationId: "org-user-a",
      accountId: "account-user-a",
      action: "content.publish",
      riskTier: "critical",
      role: "independent_reviewer",
    })).toHaveLength(1);
  });

  it("invalidates an approved claim when an authority is revoked", async () => {
    const { gateway, approvals, authorities, resources, audit, store } = await makeServices();
    const context = { humanId: "user-a" as const, agentId: "agent-a", runId: "run-authority-revoke" };
    const request = {
      requestId: "request-authority-revoke",
      action: "content.publish" as const,
      resourceId: "asset-user-a-video-2",
      destination: "tiktok-account:brand-sg",
      payload: contentPayload({ purpose: "creator_requested_publish", assetId: "asset-user-a-video-2" }),
    };
    const pending = await gateway.execute(context, request);
    if (pending.status !== "approval_required") throw new Error("Expected critical approval");
    await approvals.approve(pending.approvalId, "user-a");
    await approvals.approve(pending.approvalId, "user-c");
    await authorities.revoke("approval-authority:user-c:org-a-reviewer");
    await expect(gateway.execute(context, { ...request, approvalId: pending.approvalId })).resolves.toMatchObject({
      status: "denied",
      reasonCode: "approval_authority_revoked",
    });
    expect(resources.getExecutionCount("content.publish", "asset-user-a-video-2")).toBe(0);
    expect(audit.list("agent-a")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "approval.revoked",
        reasonCode: "approval_authority_revoked",
        explanation: "The mutable authority behind this approval was revoked before the protected action could execute.",
      }),
    ]));
    expect(store.snapshot().auditEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "approval.revoked",
        enforcementPoint: "ApprovalAuthorityService",
        agentId: null,
        resourceId: null,
        protectedActionExecuted: false,
      }),
    ]));
    expect(JSON.stringify(audit.list("agent-a"))).not.toContain("Synthetic");
  });

  it("serializes concurrent final approvals into one capability", async () => {
    const { gateway, approvals, store } = await makeServices();
    const context = { humanId: "user-a" as const, agentId: "agent-a", runId: "run-critical-concurrent" };
    const request = {
      requestId: "request-critical-concurrent",
      action: "content.publish" as const,
      resourceId: "asset-user-a-video-2",
      destination: "tiktok-account:brand-sg",
      payload: contentPayload({ purpose: "creator_requested_publish", assetId: "asset-user-a-video-2" }),
    };
    const pending = await gateway.execute(context, request);
    if (pending.status !== "approval_required") throw new Error("Expected critical approval");
    await approvals.approve(pending.approvalId, "user-a");

    const outcomes = await Promise.allSettled([
      approvals.approve(pending.approvalId, "user-c"),
      approvals.approve(pending.approvalId, "user-c"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const rejection = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejection).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "APPROVAL_ALREADY_DECIDED" }),
    });
    expect(store.snapshot().capabilityClaims).toHaveLength(1);
  });

  it("rejects a capability when an approval authority revision changes before execution", async () => {
    const { gateway, approvals, store } = await makeServices();
    const context = { humanId: "user-a" as const, agentId: "agent-a", runId: "run-authority-revision" };
    const request = {
      requestId: "request-authority-revision",
      action: "content.publish" as const,
      resourceId: "asset-user-a-video-2",
      destination: "tiktok-account:brand-sg",
      payload: contentPayload({ purpose: "creator_requested_publish", assetId: "asset-user-a-video-2" }),
    };
    const pending = await gateway.execute(context, request);
    if (pending.status !== "approval_required") throw new Error("Expected critical approval");
    await approvals.approve(pending.approvalId, "user-a");
    await approvals.approve(pending.approvalId, "user-c");
    await store.mutate((database) => {
      const authority = database.approvalAuthorities.find((candidate) => candidate.humanId === "user-c");
      if (!authority) throw new Error("Expected reviewer authority");
      authority.revision += 1;
      authority.updatedAt = new Date().toISOString();
    });

    await expect(gateway.execute(context, { ...request, approvalId: pending.approvalId })).resolves.toMatchObject({
      status: "denied",
      reasonCode: "approval_authority_revoked",
    });
  });

  it("fails closed for a persisted critical approval or claim reduced to one slot", async () => {
    const { gateway, approvals, store } = await makeServices();
    const context = { humanId: "user-a" as const, agentId: "agent-a", runId: "run-critical-malformed" };
    const request = {
      requestId: "request-critical-malformed",
      action: "content.publish" as const,
      resourceId: "asset-user-a-video-2",
      destination: "tiktok-account:brand-sg",
      payload: contentPayload({ purpose: "creator_requested_publish", assetId: "asset-user-a-video-2" }),
    };
    const pending = await gateway.execute(context, request);
    if (pending.status !== "approval_required") throw new Error("Expected critical approval");
    await store.mutate((database) => {
      const approval = database.approvals.find((candidate) => candidate.id === pending.approvalId);
      if (!approval) throw new Error("Expected approval");
      approval.requiredApprovalCount = 1;
      approval.requiredApprovalRoles = ["owner"];
    });
    await expect(approvals.approve(pending.approvalId, "user-a")).rejects.toMatchObject({
      code: "APPROVAL_INVALID",
    });

    const valid = await gateway.execute(context, { ...request, requestId: "request-critical-valid-before-tamper" });
    if (valid.status !== "approval_required") throw new Error("Expected critical approval");
    await approvals.approve(valid.approvalId, "user-a");
    await approvals.approve(valid.approvalId, "user-c");
    await store.mutate((database) => {
      const approval = database.approvals.find((candidate) => candidate.id === valid.approvalId);
      const claim = database.capabilityClaims.find((candidate) => candidate.approvalId === valid.approvalId);
      if (!approval || !claim) throw new Error("Expected approved critical claim");
      approval.requiredApprovalCount = 1;
      approval.requiredApprovalRoles = ["owner"];
      approval.approvalDecisions = approval.approvalDecisions.slice(0, 1);
      claim.requiredApprovalCount = 1;
      claim.requiredApprovalRoles = ["owner"];
      claim.approvalDecisions = claim.approvalDecisions.slice(0, 1);
    });

    const migrated = migrateDatabase(store.snapshot());
    expect(migrated.approvals.find((candidate) => candidate.id === valid.approvalId)).toMatchObject({
      status: "revoked",
      risk: "critical",
    });
    expect(migrated.capabilityClaims).toEqual([]);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeterministicPolicyEngine } from "./policy-engine.js";
import { ApprovalService } from "./approval-service.js";
import { AuditService } from "./audit-service.js";
import { ProtectedResourceService } from "./protected-resource-service.js";
import { RuntimeGateway } from "./runtime-gateway.js";
import { JsonStore } from "../store.js";
import { AGENTGATE_POLICY_VERSION } from "./types.js";
import type { AgentTeamGrant } from "./types.js";
import { RuntimeCredentialService } from "./runtime-credential-service.js";
import type { Database } from "../types.js";
import { DestinationCatalogueService } from "./destination-catalogue.js";
import { LocalDestinationAdapter } from "./local-destination-adapter.js";
import { ServerSideCredentialBroker } from "./destination-broker.js";
import { CONTENT_DESTINATIONS } from "./content-model.js";
import { DeterministicRiskEngine, type RiskEngine } from "./risk-engine.js";

class InterleavingJsonStore extends JsonStore {
  interleaveNextMutation = false;
  interleaveResourceId = "production";
  interleaveTarget: "resource" | "destination" = "resource";

  override async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    if (this.interleaveNextMutation) {
      this.interleaveNextMutation = false;
      await super.mutate((database) => {
        if (this.interleaveTarget === "destination") {
          const destination = database.registeredDestinations.find(
            (candidate) => candidate.id === this.interleaveResourceId,
          );
          if (!destination) throw new Error("Expected interleaved destination");
          destination.revision += 1;
          return;
        }
        const resource = database.protectedResources.find(
          (candidate) => candidate.id === this.interleaveResourceId,
        );
        if (!resource) throw new Error("Expected interleaved resource");
        resource.revision += 1;
      });
    }
    return super.mutate(mutation);
  }
}

const temporaryDirectories: string[] = [];
const context = { humanId: "user-a" as const, agentId: "agent-a", runId: "run-a" };

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
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeGateway(
  createStore: (filePath: string) => JsonStore = (filePath) => new JsonStore(filePath),
  includeDestinationCatalogue = true,
  broker = new ServerSideCredentialBroker(),
  riskEngine: RiskEngine = new DeterministicRiskEngine(),
): Promise<{
  gateway: RuntimeGateway;
  resources: ProtectedResourceService;
  approvals: ApprovalService;
  audit: AuditService;
  store: JsonStore;
  destinations: DestinationCatalogueService;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "agentgate-gateway-test-"));
  temporaryDirectories.push(root);
  const store = createStore(path.join(root, "db.json"));
  await store.initialize();
  const createdAt = "2026-08-30T00:00:00.000Z";
  await store.mutate((database) => {
    database.agents.push(
      {
        id: "agent-a",
        ownerUserId: "user-a",
        name: "Agent A",
        description: "",
        instructions: "",
        status: "ready",
        workspacePath: path.join(root, "agent-a"),
        codexThreadId: null,
        lastError: null,
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: "agent-b",
        ownerUserId: "user-b",
        name: "Agent B",
        description: "",
        instructions: "",
        status: "ready",
        workspacePath: path.join(root, "agent-b"),
        codexThreadId: null,
        lastError: null,
        createdAt,
        updatedAt: createdAt,
      },
    );
    const grants: AgentTeamGrant[] = [
      {
        id: "grant-agent-a-alpha",
        agentId: "agent-a",
        teamId: "team-alpha",
        role: "admin",
        allowedActions: ["file.read"],
        status: "active",
        approvedBy: "user-a",
        expiresAt: null,
        bundleVersion: 1,
        createdAt,
        updatedAt: createdAt,
        revokedAt: null,
      },
      {
        id: "grant-agent-b-alpha",
        agentId: "agent-b",
        teamId: "team-alpha",
        role: "viewer",
        allowedActions: ["file.read"],
        status: "active",
        approvedBy: "user-a",
        expiresAt: null,
        bundleVersion: 1,
        createdAt,
        updatedAt: createdAt,
        revokedAt: null,
      },
    ];
    database.agentTeamGrants.push(...grants);
  });
  const audit = new AuditService(store);
  const approvals = new ApprovalService(store, audit);
  const destinations = new DestinationCatalogueService(store, approvals);
  const destinationAdapter = new LocalDestinationAdapter(
    store,
    destinations,
    broker,
  );
  const contentResources = new ProtectedResourceService(store, approvals, destinationAdapter);
  return {
    resources: contentResources,
    approvals,
    audit,
    store,
    destinations,
    gateway: new RuntimeGateway(
      new DeterministicPolicyEngine(),
      contentResources,
      audit,
      approvals,
      store,
      undefined,
      undefined,
      undefined,
      includeDestinationCatalogue ? destinations : undefined,
      riskEngine,
    ),
  };
}

describe("RuntimeGateway", () => {
  it("executes an allowed own-resource read", async () => {
    const { gateway, resources, audit } = await makeGateway();
    const result = await gateway.execute(context, {
      requestId: "request-read",
      action: "resource.read",
      resourceId: "project-a",
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.result.content).toContain("project-a");
    }
    expect(resources.getExecutionCount("resource.read", "project-a")).toBe(1);
    expect(audit.list("agent-a")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "policy.allow",
          reasonCode: "owned_resource_read",
          explanation: "The Agent is authorized as the owner of this protected resource.",
        }),
      ]),
    );
    expect(JSON.stringify(audit.list("agent-a"))).not.toContain(
      "Synthetic profile for project-a",
    );
  });

  it("denies cross-user and unknown resources without execution", async () => {
    const { gateway, resources } = await makeGateway();
    const crossUser = await gateway.execute(context, {
      requestId: "request-cross-user",
      action: "resource.read",
      resourceId: "project-b",
    });
    expect(crossUser).toMatchObject({
      status: "denied",
      reasonCode: "resource_owner_mismatch",
    });
    expect(JSON.stringify(crossUser)).not.toContain("User B");
    expect(resources.getExecutionCount("resource.read", "project-b")).toBe(0);

    const unknown = await gateway.execute(context, {
      requestId: "request-unknown",
      action: "resource.read",
      resourceId: "not-registered",
    });
    expect(unknown).toMatchObject({ status: "denied", reasonCode: "unknown_resource" });
  });

  it("separates aggregate moderation from explicitly scoped disclosure", async () => {
    const { gateway, resources, audit } = await makeGateway();
    const moderation = await gateway.execute(context, {
      requestId: "request-content-moderate",
      action: "content.moderate",
      resourceId: "asset-user-a-video-1",
      payload: contentPayload(),
    });
    expect(moderation).toMatchObject({ status: "success", action: "content.moderate" });
    if (moderation.status !== "success") throw new Error("Expected moderation success");
    expect(moderation.result.content).toBeUndefined();
    expect(moderation.result.summary).toContain("aggregate-only");

    const disclosure = await gateway.execute(context, {
      requestId: "request-content-disclose",
      action: "content.disclose",
      resourceId: "asset-user-a-video-1",
      destination: CONTENT_DESTINATIONS.analytics,
      payload: contentPayload({ purpose: "approved_analytics" }),
    });
    expect(disclosure).toMatchObject({ status: "success", action: "content.disclose" });
    if (disclosure.status !== "success") throw new Error("Expected disclosure success");
    expect(disclosure.result.content).toContain("Synthetic User A");
    expect(resources.getExecutionCount("content.moderate", "asset-user-a-video-1")).toBe(1);
    expect(resources.getExecutionCount("content.disclose", "asset-user-a-video-1")).toBe(1);
    expect(JSON.stringify(audit.list("agent-a"))).not.toContain("Synthetic User A short-form video payload");
  });

  it("fails closed when the RuntimeGateway has no server-resolved destination catalogue", async () => {
    const { gateway, resources } = await makeGateway(undefined, false);
    await expect(gateway.execute(context, {
      requestId: "request-content-no-catalogue",
      action: "content.disclose",
      resourceId: "asset-user-a-video-1",
      destination: CONTENT_DESTINATIONS.analytics,
      payload: contentPayload({ purpose: "approved_analytics" }),
    })).resolves.toMatchObject({
      status: "denied",
      reasonCode: "content_destination_unknown",
    });
    expect(resources.getExecutionCount("content.disclose", "asset-user-a-video-1")).toBe(0);
  });

  it("strictly rejects missing or mismatched content purpose, hierarchy, scope, and destination", async () => {
    const { gateway, resources } = await makeGateway();
    const cases: Array<{
      requestId: string;
      context?: typeof context;
      action: "content.moderate" | "content.disclose" | "content.publish";
      resourceId: string;
      payload: unknown;
      destination?: string;
      reasonCode: string;
    }> = [
      {
        requestId: "request-content-missing-purpose",
        action: "content.moderate",
        resourceId: "asset-user-a-video-1",
        payload: {
          organizationId: "org-user-a",
          businessCenterId: "business-center-user-a",
          accountId: "account-user-a",
          assetId: "asset-user-a-video-1",
          contentVersion: "v1",
        },
        reasonCode: "malformed_attributes",
      },
      {
        requestId: "request-content-purpose-mismatch",
        action: "content.moderate",
        resourceId: "asset-user-a-video-1",
        payload: contentPayload({ purpose: "creator_requested_publish" }),
        reasonCode: "content_purpose_mismatch",
      },
      {
        requestId: "request-content-unknown-purpose",
        action: "content.moderate",
        resourceId: "asset-user-a-video-1",
        payload: contentPayload({ purpose: "unknown_purpose" }),
        reasonCode: "malformed_attributes",
      },
      {
        requestId: "request-content-business-mismatch",
        action: "content.moderate",
        resourceId: "asset-user-a-video-1",
        payload: contentPayload({ businessCenterId: "business-center-user-b" }),
        reasonCode: "content_asset_mismatch",
      },
      {
        requestId: "request-content-asset-mismatch",
        action: "content.moderate",
        resourceId: "asset-user-a-video-1",
        payload: contentPayload({ assetId: "asset-user-a-video-2" }),
        reasonCode: "content_asset_mismatch",
      },
      {
        requestId: "request-content-disclosure-scope-missing",
        action: "content.disclose",
        resourceId: "asset-user-a-video-2",
        payload: contentPayload({
          purpose: "approved_analytics",
          assetId: "asset-user-a-video-2",
        }),
        destination: CONTENT_DESTINATIONS.analytics,
        reasonCode: "content_scope_missing",
      },
      {
        requestId: "request-content-unknown-destination",
        action: "content.publish",
        resourceId: "asset-user-a-video-1",
        payload: contentPayload({ purpose: "creator_requested_publish" }),
        destination: "https://unregistered.example",
        reasonCode: "content_destination_unknown",
      },
      {
        requestId: "request-content-cross-user",
        context: { humanId: "user-a", agentId: "agent-a", runId: "run-content-cross-user" },
        action: "content.moderate",
        resourceId: "asset-user-b-video-1",
        payload: {
          purpose: "safety_moderation",
          organizationId: "org-user-b",
          businessCenterId: "business-center-user-b",
          accountId: "account-user-b",
          assetId: "asset-user-b-video-1",
          contentVersion: "v1",
        },
        reasonCode: "resource_owner_mismatch",
      },
    ];
    for (const testCase of cases) {
      await expect(gateway.execute(testCase.context ?? context, {
        requestId: testCase.requestId,
        action: testCase.action,
        resourceId: testCase.resourceId,
        payload: testCase.payload,
        ...(testCase.destination ? { destination: testCase.destination } : {}),
      })).resolves.toMatchObject({ status: "denied", reasonCode: testCase.reasonCode });
    }
    expect(resources.getExecutionCount("content.moderate", "asset-user-a-video-1")).toBe(0);
    expect(resources.getExecutionCount("content.disclose", "asset-user-a-video-2")).toBe(0);
    expect(resources.getExecutionCount("content.publish", "asset-user-a-video-1")).toBe(0);
  });

  it("enforces registered destination action, purpose, tenant, and revocation", async () => {
    const { gateway, destinations, resources } = await makeGateway();
    await expect(gateway.execute(context, {
      requestId: "request-destination-action-mismatch",
      action: "content.disclose",
      resourceId: "asset-user-a-video-1",
      destination: CONTENT_DESTINATIONS.publishUserA,
      payload: contentPayload({ purpose: "approved_analytics" }),
    })).resolves.toMatchObject({
      status: "denied",
      reasonCode: "content_destination_action_mismatch",
    });

    await expect(gateway.execute(context, {
      requestId: "request-destination-purpose-mismatch",
      action: "content.publish",
      resourceId: "asset-user-a-video-1",
      destination: CONTENT_DESTINATIONS.publishUserA,
      payload: contentPayload({ purpose: "approved_analytics" }),
    })).resolves.toMatchObject({
      status: "denied",
      reasonCode: "content_purpose_mismatch",
    });

    await expect(gateway.execute(context, {
      requestId: "request-destination-tenant-mismatch",
      action: "content.publish",
      resourceId: "asset-user-a-video-1",
      destination: CONTENT_DESTINATIONS.publishUserB,
      payload: contentPayload({ purpose: "creator_requested_publish" }),
    })).resolves.toMatchObject({
      status: "denied",
      reasonCode: "content_destination_tenant_mismatch",
    });

    await destinations.revoke(CONTENT_DESTINATIONS.analytics);
    await expect(gateway.execute(context, {
      requestId: "request-destination-revoked",
      action: "content.disclose",
      resourceId: "asset-user-a-video-1",
      destination: CONTENT_DESTINATIONS.analytics,
      payload: contentPayload({ purpose: "approved_analytics" }),
    })).resolves.toMatchObject({
      status: "denied",
      reasonCode: "content_destination_revoked",
    });
    expect(resources.getExecutionCount("content.disclose", "asset-user-a-video-1")).toBe(0);
  });

  it("fails without a broker credential and leaves the destination receipt empty", async () => {
    const { gateway, approvals, resources, store, audit } = await makeGateway(
      undefined,
      true,
      new ServerSideCredentialBroker(new Map()),
    );
    const publish = {
      requestId: "request-content-missing-broker-credential",
      action: "content.publish" as const,
      resourceId: "asset-user-a-video-1",
      destination: CONTENT_DESTINATIONS.publishUserA,
      payload: contentPayload({ purpose: "creator_requested_publish" }),
    };
    const pending = await gateway.execute(context, publish);
    expect(pending).toMatchObject({ status: "approval_required" });
    if (pending.status !== "approval_required") throw new Error("Expected publish approval");
    await approvals.approve(pending.approvalId, "user-a");

    await expect(gateway.execute(context, {
      ...publish,
      approvalId: pending.approvalId,
    })).resolves.toMatchObject({ status: "failed", reasonCode: "protected_action_failed" });
    expect(resources.getExecutionCount("content.publish", "asset-user-a-video-1")).toBe(0);
    expect(store.snapshot().destinationReceipts).toEqual([]);
    expect(JSON.stringify(audit.list("agent-a"))).not.toContain("SYNTHETIC_DESTINATION_SECRET_CANARY");
  });

  it("rejects changed protected content before creating approval", async () => {
    const { gateway, store } = await makeGateway();
    await store.mutate((database) => {
      const asset = database.protectedResources.find(
        (resource) => resource.id === "asset-user-a-video-1",
      );
      if (!asset || asset.type !== "content_asset") throw new Error("Expected content asset");
      asset.contentVersion = "v2";
    });
    await expect(gateway.execute(context, {
      requestId: "request-content-changed",
      action: "content.moderate",
      resourceId: "asset-user-a-video-1",
      payload: contentPayload(),
    })).resolves.toMatchObject({ status: "denied", reasonCode: "content_version_mismatch" });
  });

  it("preserves exact publish and export binding through owner approval and replay", async () => {
    const { gateway, approvals, resources, audit, store, destinations } = await makeGateway();
    const publish = {
      requestId: "request-content-publish",
      action: "content.publish" as const,
      resourceId: "asset-user-a-video-1",
      destination: CONTENT_DESTINATIONS.publishUserA,
      payload: contentPayload({ purpose: "creator_requested_publish" }),
    };
    const pendingPublish = await gateway.execute(context, publish);
    expect(pendingPublish).toMatchObject({
      status: "approval_required",
      reasonCode: "content_publish_requires_owner_approval",
    });
    if (pendingPublish.status !== "approval_required") throw new Error("Expected publish approval");
    await approvals.approve(pendingPublish.approvalId, "user-a");
    await expect(gateway.execute(context, {
      ...publish,
      payload: contentPayload({ purpose: "creator_requested_publish", contentVersion: "v2" }),
    })).resolves.toMatchObject({ status: "denied", reasonCode: "content_version_mismatch" });
    const approvedPublish = await gateway.execute(context, {
      ...publish,
      approvalId: pendingPublish.approvalId,
    });
    expect(approvedPublish).toMatchObject({ status: "success" });
    const receiptCountAfterPublish = store.snapshot().destinationReceipts.length;
    await expect(gateway.execute(context, {
      ...publish,
      approvalId: pendingPublish.approvalId,
    })).resolves.toMatchObject({ status: "success" });
    expect(store.snapshot().destinationReceipts).toHaveLength(receiptCountAfterPublish);
    await destinations.bumpRevision(CONTENT_DESTINATIONS.publishUserA);
    await expect(gateway.execute(context, {
      ...publish,
      approvalId: pendingPublish.approvalId,
    })).resolves.toMatchObject({ status: "success" });
    expect(store.snapshot().destinationReceipts).toHaveLength(receiptCountAfterPublish);
    await destinations.revoke(CONTENT_DESTINATIONS.publishUserA);
    await expect(gateway.execute(context, {
      ...publish,
      approvalId: pendingPublish.approvalId,
    })).resolves.toMatchObject({ status: "success" });
    expect(store.snapshot().destinationReceipts).toHaveLength(receiptCountAfterPublish);
    const secretEvidence = JSON.stringify({
      response: approvedPublish,
      audit: audit.list("agent-a"),
      persisted: store.snapshot(),
    });
    expect(secretEvidence).not.toContain("SYNTHETIC_DESTINATION_SECRET_CANARY");
    expect(store.snapshot().destinationReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        destinationId: CONTENT_DESTINATIONS.publishUserA,
        credentialRef: "credential-ref:tiktok:brand-sg",
      }),
    ]));
    await expect(gateway.execute(context, {
      ...publish,
      requestId: "request-content-publish-substitution",
      destination: CONTENT_DESTINATIONS.publishUserB,
      approvalId: pendingPublish.approvalId,
    })).resolves.toMatchObject({ status: "denied", reasonCode: "content_destination_tenant_mismatch" });
    expect(resources.getExecutionCount("content.publish", "asset-user-a-video-1")).toBe(1);

    const exportRequest = {
      requestId: "request-content-export",
      action: "content.export" as const,
      resourceId: "asset-user-a-video-1",
      destination: CONTENT_DESTINATIONS.archiveUserA,
      payload: contentPayload({ purpose: "compliance_archive" }),
    };
    const pendingExport = await gateway.execute(context, exportRequest);
    expect(pendingExport).toMatchObject({
      status: "approval_required",
      reasonCode: "content_export_requires_owner_approval",
    });
    if (pendingExport.status !== "approval_required") throw new Error("Expected export approval");
    await approvals.approve(pendingExport.approvalId, "user-a");
    await expect(gateway.execute(context, {
      ...exportRequest,
      approvalId: pendingExport.approvalId,
    })).resolves.toMatchObject({ status: "success" });
    expect(resources.getExecutionCount("content.export", "asset-user-a-video-1")).toBe(1);

    const creatorRequest = {
      requestId: "request-content-creator-demo",
      action: "content.publish" as const,
      resourceId: "asset-user-b-video-1",
      destination: CONTENT_DESTINATIONS.publishUserB,
      payload: contentPayload({
        purpose: "creator_requested_publish",
        organizationId: "org-user-b",
        businessCenterId: "business-center-user-b",
        accountId: "account-user-b",
        assetId: "asset-user-b-video-1",
      }),
    };
    const pendingCreator = await gateway.execute(
      { humanId: "user-b", agentId: "agent-b", runId: "run-creator-demo" },
      creatorRequest,
    );
    expect(pendingCreator).toMatchObject({ status: "approval_required" });
    if (pendingCreator.status !== "approval_required") throw new Error("Expected creator approval");
    await approvals.approve(pendingCreator.approvalId, "user-b");
    await expect(gateway.execute(
      { humanId: "user-b", agentId: "agent-b", runId: "run-creator-demo" },
      { ...creatorRequest, approvalId: pendingCreator.approvalId },
    )).resolves.toMatchObject({ status: "success" });
    expect(resources.getExecutionCount("content.publish", "asset-user-b-video-1")).toBe(1);
  });

  it("enforces server-resolved team membership and role at the protected file boundary", async () => {
    const { gateway, resources, audit, store } = await makeGateway();
    const alphaAsAdmin = await gateway.execute(context, {
      requestId: "request-alpha-admin",
      action: "file.read",
      resourceId: "team-alpha-internal",
    });
    expect(alphaAsAdmin).toMatchObject({ status: "success", action: "file.read" });
    if (alphaAsAdmin.status === "success") {
      expect(alphaAsAdmin.result.content).toContain("Team Alpha");
    }

    const alphaAsViewer = await gateway.execute(
      { humanId: "user-b", agentId: "agent-b", runId: "run-b" },
      {
        requestId: "request-alpha-viewer",
        action: "file.read",
        resourceId: "team-alpha-internal",
      },
    );
    expect(alphaAsViewer).toMatchObject({ status: "success" });

    const restricted = await gateway.execute(
      { humanId: "user-b", agentId: "agent-b", runId: "run-b" },
      {
        requestId: "request-alpha-restricted",
        action: "file.read",
        resourceId: "team-alpha-restricted",
      },
    );
    expect(restricted).toMatchObject({ status: "denied", reasonCode: "team_role_insufficient" });

    const wrongTeam = await gateway.execute(context, {
      requestId: "request-beta-wrong-team",
      action: "file.read",
      resourceId: "team-beta-internal",
    });
    expect(wrongTeam).toMatchObject({ status: "denied", reasonCode: "team_membership_missing" });
    expect(resources.getExecutionCount("file.read", "team-alpha-internal")).toBe(2);
    expect(resources.getExecutionCount("file.read", "team-alpha-restricted")).toBe(0);
    expect(resources.getExecutionCount("file.read", "team-beta-internal")).toBe(0);
    expect(audit.list("agent-a")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "policy.allow",
          resourceId: "team-alpha-internal",
          policyVersion: AGENTGATE_POLICY_VERSION,
          grantId: "grant-agent-a-alpha",
          teamId: "team-alpha",
          effectiveScope: ["file.read"],
        }),
      ]),
    );
    expect(JSON.stringify(audit.list("agent-a"))).not.toContain("Synthetic internal Team Alpha file");
    expect(JSON.stringify(store.snapshot())).not.toContain("Synthetic internal Team Alpha file");
  });

  it("denies a team-file read when the human is a member but the Agent is not enrolled", async () => {
    const { gateway, resources, store } = await makeGateway();
    await store.mutate((database) => {
      database.agentTeamGrants = database.agentTeamGrants.filter(
        (grant) => grant.agentId !== "agent-a",
      );
    });

    const result = await gateway.execute(context, {
      requestId: "request-alpha-no-agent-grant",
      action: "file.read",
      resourceId: "team-alpha-internal",
    });

    expect(result).toMatchObject({ status: "denied", reasonCode: "agent_grant_missing" });
    expect(resources.getExecutionCount("file.read", "team-alpha-internal")).toBe(0);
  });

  it("denies revoked and under-scoped grants, while elevating a viewer grant only once", async () => {
    const { gateway, resources, store, approvals } = await makeGateway();
    const updateGrant = async (
      update: (grant: AgentTeamGrant) => void,
    ) => store.mutate((database) => {
      const grant = database.agentTeamGrants.find(
        (candidate) => candidate.id === "grant-agent-a-alpha",
      );
      if (!grant) throw new Error("Expected seeded Agent grant");
      grant.status = "active";
      grant.role = "admin";
      grant.allowedActions = ["file.read"];
      grant.expiresAt = null;
      grant.revokedAt = null;
      update(grant);
    });

    await updateGrant((grant) => {
      grant.status = "revoked";
      grant.revokedAt = "2026-08-30T01:00:00.000Z";
    });
    await expect(gateway.execute(context, {
      requestId: "request-revoked-grant",
      action: "file.read",
      resourceId: "team-alpha-internal",
    })).resolves.toMatchObject({ status: "denied", reasonCode: "agent_grant_revoked" });

    await updateGrant((grant) => {
      grant.expiresAt = "2000-01-01T00:00:00.000Z";
    });
    await expect(gateway.execute(context, {
      requestId: "request-expired-grant",
      action: "file.read",
      resourceId: "team-alpha-internal",
    })).resolves.toMatchObject({ status: "denied", reasonCode: "agent_grant_expired" });

    await updateGrant((grant) => {
      grant.allowedActions = [];
    });
    await expect(gateway.execute(context, {
      requestId: "request-under-scoped-grant",
      action: "file.read",
      resourceId: "team-alpha-internal",
    })).resolves.toMatchObject({
      status: "denied",
      reasonCode: "agent_grant_action_under_scoped",
    });

    await updateGrant((grant) => {
      grant.role = "viewer";
    });
    const pending = await gateway.execute(context, {
      requestId: "request-under-role-grant",
      action: "file.read",
      resourceId: "team-alpha-restricted",
    });
    expect(pending).toMatchObject({
      status: "approval_required",
      reasonCode: "restricted_file_requires_temporary_elevation",
    });
    if (pending.status !== "approval_required") throw new Error("Expected JIT approval");
    await approvals.approve(pending.approvalId, "user-a");
    await expect(gateway.execute(context, {
      requestId: "request-under-role-grant",
      action: "file.read",
      resourceId: "team-alpha-restricted",
      approvalId: pending.approvalId,
    })).resolves.toMatchObject({ status: "success" });

    expect(resources.getExecutionCount("file.read", "team-alpha-internal")).toBe(0);
    expect(resources.getExecutionCount("file.read", "team-alpha-restricted")).toBe(1);
    expect(store.snapshot().agentTeamGrants.find((grant) => grant.id === "grant-agent-a-alpha")).toMatchObject({
      role: "viewer",
      status: "active",
      allowedActions: ["file.read"],
      bundleVersion: 1,
    });
    await expect(approvals.get(pending.approvalId)).resolves.toMatchObject({ status: "consumed" });
  });

  it("denies a queued initially-allowed action after Run authority revocation", async () => {
    const { resources, approvals, audit, store } = await makeGateway();
    const credentials = new RuntimeCredentialService();
    const guarded = new RuntimeGateway(
      new DeterministicPolicyEngine(),
      resources,
      audit,
      approvals,
      store,
      undefined,
      undefined,
      credentials,
    );
    const guardedContext = { humanId: "user-a" as const, agentId: "agent-a", runId: "run-demo-queue" };
    credentials.issue(guardedContext.agentId, guardedContext.runId, guardedContext.humanId);
    const requestId = "request-demo-queue";
    const barrier = guarded.createDemoExecutionBarrier(guardedContext.runId, requestId);
    const execution = guarded.execute(guardedContext, {
      requestId,
      action: "resource.read",
      resourceId: "project-a",
    });
    await barrier.reached;
    credentials.revokeAuthority(guardedContext.runId);
    barrier.release();
    await expect(execution).resolves.toMatchObject({
      status: "denied",
      reasonCode: "runtime_authority_revoked",
    });
    expect(resources.getExecutionCount("resource.read", "project-a")).toBe(0);
    expect(audit.list("agent-a")).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId, eventType: "policy.allow" }),
      expect.objectContaining({ requestId, eventType: "policy.deny", reasonCode: "runtime_authority_revoked" }),
    ]));
  });

  it("rechecks a persistent Agent grant after queueing and before the protected file read", async () => {
    const { resources, approvals, store } = await makeGateway();
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstEnteredPromise = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const blockingResources = {
      getMetadata: (resourceId: string) => resources.getMetadata(resourceId),
      execute: async (...args: Parameters<ProtectedResourceService["execute"]>) => {
        if (args[2]?.requestId === "request-queue-blocker") {
          firstEntered();
          await firstBlocked;
        }
        return resources.execute(...args);
      },
    };
    let initialTeamAllowRecorded!: () => void;
    const initialTeamAllowPromise = new Promise<void>((resolve) => {
      initialTeamAllowRecorded = resolve;
    });
    class SignallingAuditService extends AuditService {
      override async record(input: Parameters<AuditService["record"]>[0]) {
        const event = await super.record(input);
        if (
          input.requestId === "request-queued-team-read" &&
          input.eventType === "policy.allow"
        ) {
          initialTeamAllowRecorded();
        }
        return event;
      }
    }
    const audit = new SignallingAuditService(store);
    const gateway = new RuntimeGateway(
      new DeterministicPolicyEngine(),
      blockingResources,
      audit,
      approvals,
      store,
    );

    const blocker = gateway.execute(context, {
      requestId: "request-queue-blocker",
      action: "resource.read",
      resourceId: "project-a",
    });
    await firstEnteredPromise;
    const queuedRead = gateway.execute(context, {
      requestId: "request-queued-team-read",
      action: "file.read",
      resourceId: "team-alpha-internal",
    });
    await initialTeamAllowPromise;
    await Promise.resolve();
    await store.mutate((database) => {
      const grant = database.agentTeamGrants.find(
        (candidate) => candidate.id === "grant-agent-a-alpha",
      );
      if (!grant) throw new Error("Expected seeded Agent grant");
      grant.status = "revoked";
      grant.revokedAt = "2026-08-30T01:00:00.000Z";
      grant.updatedAt = grant.revokedAt;
    });
    releaseFirst();

    await expect(blocker).resolves.toMatchObject({ status: "success" });
    await expect(queuedRead).resolves.toMatchObject({
      status: "denied",
      reasonCode: "agent_grant_revoked",
    });
    expect(resources.getExecutionCount("file.read", "team-alpha-internal")).toBe(0);
    expect(audit.list("agent-a")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: "request-queued-team-read",
          eventType: "policy.deny",
          reasonCode: "agent_grant_revoked",
          protectedActionExecuted: false,
        }),
      ]),
    );
  });

  it("does not accept membership attributes supplied in the runtime request", async () => {
    const { gateway, resources } = await makeGateway();
    const forged = await gateway.execute(context, {
      requestId: "request-forged-membership",
      action: "file.read",
      resourceId: "team-alpha-internal",
      memberships: [{ teamId: "team-alpha", humanId: "user-a", role: "admin" }],
    } as never);
    expect(forged).toMatchObject({ status: "denied", reasonCode: "invalid_context" });
    expect(resources.getExecutionCount("file.read", "team-alpha-internal")).toBe(0);
  });

  it("does not deploy production before approval", async () => {
    const { gateway, resources, approvals, audit } = await makeGateway();
    const result = await gateway.execute(context, {
      requestId: "request-production",
      action: "deploy.production",
      resourceId: "production",
    });

    expect(result).toMatchObject({
      status: "approval_required",
      reasonCode: "production_deploy_requires_owner_approval",
    });
    expect(resources.getExecutionCount("deploy.production", "production")).toBe(0);
    expect(resources.getDeploymentState("production", "production")?.deploymentCount).toBe(0);

    if (result.status !== "approval_required") throw new Error("Expected approval");
    await approvals.approve(result.approvalId, "user-a");
    const approved = await gateway.execute(context, {
      requestId: "request-production",
      action: "deploy.production",
      resourceId: "production",
      approvalId: result.approvalId,
    });
    expect(approved).toMatchObject({ status: "success", action: "deploy.production" });
    expect(resources.getExecutionCount("deploy.production", "production")).toBe(1);
    expect(resources.getDeploymentState("production", "production")?.deploymentCount).toBe(1);
    expect(audit.list("agent-a").map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "policy.approval_required",
        "approval.approved",
        "capability.issued",
        "capability.consumed",
        "protected_action.succeeded",
      ]),
    );
    expect(
      audit
        .list("agent-a")
        .filter((event) => event.eventType.startsWith("policy."))
        .every((event) => event.policyVersion === AGENTGATE_POLICY_VERSION),
    ).toBe(true);

    const replay = await gateway.execute(context, {
      requestId: "request-production",
      action: "deploy.production",
      resourceId: "production",
      approvalId: result.approvalId,
    });
    expect(replay).toMatchObject({ status: "success" });
    expect(resources.getExecutionCount("deploy.production", "production")).toBe(1);

    const hostileReplay = await gateway.execute(context, {
      requestId: "f3b9c3c6-ef9a-45f0-8d28-99b9cfb2b8b1",
      action: "deploy.production",
      resourceId: "production",
      approvalId: result.approvalId,
    });
    expect(hostileReplay).toMatchObject({
      status: "denied",
      reasonCode: "capability_consumed",
    });
    expect(resources.getExecutionCount("deploy.production", "production")).toBe(1);
    expect(audit.list("agent-a")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "policy.deny",
          reasonCode: "capability_consumed",
          protectedActionExecuted: false,
          policyVersion: AGENTGATE_POLICY_VERSION,
        }),
      ]),
    );
  });

  it("uses one canonical payload binding for approval and rejects one-character changes", async () => {
    const { gateway, resources, approvals } = await makeGateway();
    const original = {
      requestId: "request-production-payload",
      action: "deploy.production" as const,
      resourceId: "production",
      payload: { version: "release-a" },
      destination: "production-primary",
    };
    const pending = await gateway.execute(context, original);
    expect(pending).toMatchObject({ status: "approval_required" });
    if (pending.status !== "approval_required") throw new Error("Expected approval");

    await expect(
      gateway.execute(context, { ...original, payload: { version: "release-b" } }),
    ).resolves.toMatchObject({ status: "conflict", reasonCode: "idempotency_mismatch" });

    await approvals.approve(pending.approvalId, "user-a");
    await expect(
      gateway.execute(context, { ...original, approvalId: pending.approvalId }),
    ).resolves.toMatchObject({ status: "success" });
    await expect(
      gateway.execute(context, {
        ...original,
        requestId: "request-production-payload-mutated",
        payload: { version: "release-b" },
        approvalId: pending.approvalId,
      }),
    ).resolves.toMatchObject({ status: "denied", reasonCode: "capability_consumed" });
    expect(resources.getExecutionCount("deploy.production", "production")).toBe(1);
  });

  it("fails closed when a consumed capability becomes stale before the protected side effect", async () => {
    const { gateway, resources, approvals } = await makeGateway();
    const originalConsume = approvals.consumeCapability.bind(approvals);
    approvals.consumeCapability = async (request) => {
      const result = await originalConsume(request);
      if (result.status === "consumed") await resources.bumpRevision("production");
      return result;
    };
    const pending = await gateway.execute(context, {
      requestId: "request-stale-capability",
      action: "deploy.production",
      resourceId: "production",
    });
    expect(pending).toMatchObject({ status: "approval_required" });
    if (pending.status !== "approval_required") throw new Error("Expected approval");
    await approvals.approve(pending.approvalId, "user-a");

    await expect(
      gateway.execute(context, {
        requestId: "request-stale-capability",
        action: "deploy.production",
        resourceId: "production",
        approvalId: pending.approvalId,
      }),
    ).resolves.toMatchObject({ status: "denied", reasonCode: "resource_revision_changed" });
    expect(resources.getExecutionCount("deploy.production", "production")).toBe(0);
    expect(resources.getDeploymentState("production", "production")?.deploymentCount).toBe(0);
  });

  it("atomically rejects a revision bump between the protected check and deployment mutation", async () => {
    let interleavingStore!: InterleavingJsonStore;
    const { gateway, resources, approvals } = await makeGateway((filePath) => {
      interleavingStore = new InterleavingJsonStore(filePath);
      return interleavingStore;
    });
    const originalConsume = approvals.consumeCapability.bind(approvals);
    approvals.consumeCapability = async (request) => {
      const result = await originalConsume(request);
      if (result.status === "consumed") interleavingStore.interleaveNextMutation = true;
      return result;
    };
    const pending = await gateway.execute(context, {
      requestId: "request-atomic-revision",
      action: "deploy.production",
      resourceId: "production",
    });
    expect(pending).toMatchObject({ status: "approval_required" });
    if (pending.status !== "approval_required") throw new Error("Expected approval");
    await approvals.approve(pending.approvalId, "user-a");

    await expect(
      gateway.execute(context, {
        requestId: "request-atomic-revision",
        action: "deploy.production",
        resourceId: "production",
        approvalId: pending.approvalId,
      }),
    ).resolves.toMatchObject({ status: "failed", reasonCode: "protected_action_failed" });
    expect(resources.getDeploymentState("production", "production")?.deploymentCount).toBe(0);
    expect(resources.getExecutionCount("deploy.production", "production")).toBe(0);
    expect(resources.getMetadata("production")?.revision).toBe(2);
  });

  it("atomically rejects a content revision bump before recording any content action", async () => {
    let interleavingStore!: InterleavingJsonStore;
    const { gateway, resources, approvals, store } = await makeGateway((filePath) => {
      interleavingStore = new InterleavingJsonStore(filePath);
      interleavingStore.interleaveResourceId = "asset-user-a-video-1";
      return interleavingStore;
    });
    const originalConsume = approvals.consumeCapability.bind(approvals);
    approvals.consumeCapability = async (request) => {
      const result = await originalConsume(request);
      if (result.status === "consumed") interleavingStore.interleaveNextMutation = true;
      return result;
    };
    const publish = {
      requestId: "request-content-atomic-revision",
      action: "content.publish" as const,
      resourceId: "asset-user-a-video-1",
      destination: CONTENT_DESTINATIONS.publishUserA,
      payload: contentPayload({ purpose: "creator_requested_publish" }),
    };
    const pending = await gateway.execute(context, publish);
    expect(pending).toMatchObject({ status: "approval_required" });
    if (pending.status !== "approval_required") throw new Error("Expected publish approval");
    await approvals.approve(pending.approvalId, "user-a");

    await expect(gateway.execute(context, {
      ...publish,
      approvalId: pending.approvalId,
    })).resolves.toMatchObject({
      status: "failed",
      reasonCode: "protected_action_failed",
    });
    expect(resources.getMetadata("asset-user-a-video-1")?.revision).toBe(2);
    expect(resources.getExecutionCount("content.publish", "asset-user-a-video-1")).toBe(0);
    expect(store.snapshot().actionExecutions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "content.publish", status: "succeeded" }),
      ]),
    );
  });

  it("fails closed when a destination revision changes between final check and adapter receipt", async () => {
    let interleavingStore!: InterleavingJsonStore;
    const { gateway, resources, approvals, destinations, store } = await makeGateway((filePath) => {
      interleavingStore = new InterleavingJsonStore(filePath);
      return interleavingStore;
    });
    const originalConsume = approvals.consumeCapability.bind(approvals);
    approvals.consumeCapability = async (request) => {
      const result = await originalConsume(request);
      if (result.status === "consumed") {
        interleavingStore.interleaveResourceId = CONTENT_DESTINATIONS.publishUserA;
        interleavingStore.interleaveTarget = "destination";
        interleavingStore.interleaveNextMutation = true;
      }
      return result;
    };
    const publish = {
      requestId: "request-destination-atomic-revision",
      action: "content.publish" as const,
      resourceId: "asset-user-a-video-1",
      destination: CONTENT_DESTINATIONS.publishUserA,
      payload: contentPayload({ purpose: "creator_requested_publish" }),
    };
    const pending = await gateway.execute(context, publish);
    expect(pending).toMatchObject({ status: "approval_required" });
    if (pending.status !== "approval_required") throw new Error("Expected publish approval");
    await approvals.approve(pending.approvalId, "user-a");

    await expect(gateway.execute(context, {
      ...publish,
      approvalId: pending.approvalId,
    })).resolves.toMatchObject({ status: "failed", reasonCode: "protected_action_failed" });
    expect(destinations.get(CONTENT_DESTINATIONS.publishUserA)?.revision).toBe(2);
    expect(resources.getExecutionCount("content.publish", "asset-user-a-video-1")).toBe(0);
    expect(store.snapshot().destinationReceipts).toEqual([]);
    expect(store.snapshot().actionExecutions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "content.publish", status: "failed" }),
    ]));
  });

  it("requires one owner approval for a medium-risk staging deploy", async () => {
    const { gateway, approvals, resources } = await makeGateway();
    const request = {
      requestId: "request-staging",
      action: "deploy.staging",
      resourceId: "staging",
    } as const;
    const pending = await gateway.execute(context, request);
    expect(pending).toMatchObject({
      status: "approval_required",
      risk: "medium",
      requiredApprovalCount: 1,
      requiredApprovalRoles: ["owner"],
    });
    if (pending.status !== "approval_required") throw new Error("Expected staging approval");
    await approvals.approve(pending.approvalId, "user-a");
    const result = await gateway.execute(context, { ...request, approvalId: pending.approvalId });

    expect(result).toMatchObject({ status: "success", action: "deploy.staging" });
    expect(resources.getExecutionCount("deploy.staging", "staging")).toBe(1);
    expect(resources.getDeploymentState("staging", "staging")?.deploymentCount).toBe(1);
  });

  it("binds deployment risk facts to the actual staging or production environment", async () => {
    const observed: unknown[] = [];
    const delegate = new DeterministicRiskEngine();
    const riskEngine: RiskEngine = {
      assess(facts) {
        observed.push(structuredClone(facts));
        return delegate.assess(facts);
      },
    };
    const { gateway } = await makeGateway(undefined, true, new ServerSideCredentialBroker(), riskEngine);

    await gateway.execute(context, {
      requestId: "request-staging-risk-environment",
      action: "deploy.staging",
      resourceId: "staging",
    });
    await gateway.execute(context, {
      requestId: "request-production-risk-environment",
      action: "deploy.production",
      resourceId: "production",
    });

    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "deploy.staging",
        destinationEnvironment: "staging",
        assetType: "deployment_target",
      }),
      expect.objectContaining({
        action: "deploy.production",
        destinationEnvironment: "production",
        assetType: "deployment_target",
      }),
    ]));
  });

  it("serializes duplicate requests and rejects request substitution", async () => {
    const { gateway, approvals, resources } = await makeGateway();
    const request = {
      requestId: "request-duplicate",
      action: "deploy.staging" as const,
      resourceId: "staging",
    };
    const [first, second] = await Promise.all([
      gateway.execute(context, request),
      gateway.execute(context, request),
    ]);
    expect(first).toMatchObject({ status: "approval_required" });
    expect(second).toMatchObject({ status: "approval_required" });
    if (first.status !== "approval_required") throw new Error("Expected duplicate approval");
    await approvals.approve(first.approvalId, "user-a");
    const [completed, replay] = await Promise.all([
      gateway.execute(context, { ...request, approvalId: first.approvalId }),
      gateway.execute(context, { ...request, approvalId: first.approvalId }),
    ]);
    expect(completed).toMatchObject({ status: "success" });
    expect(replay).toMatchObject({ status: "success" });
    expect(resources.getExecutionCount("deploy.staging", "staging")).toBe(1);

    const mismatch = await gateway.execute(context, {
      requestId: "request-duplicate",
      action: "deploy.production",
      resourceId: "production",
    });
    expect(mismatch).toMatchObject({ status: "conflict", reasonCode: "idempotency_mismatch" });
  });

  it("hard-denies a different owner before approval lookup", async () => {
    const { gateway, approvals, audit } = await makeGateway();
    const result = await gateway.execute(
      { ...context, humanId: "user-b" },
      {
        requestId: "request-cross-owner-production",
        action: "deploy.production",
        resourceId: "production",
        approvalId: "not-a-real-approval",
      },
    );
    expect(result).toMatchObject({ status: "denied", reasonCode: "resource_owner_mismatch" });
    expect(await approvals.list("user-b")).toEqual([]);
    expect(audit.list("agent-a").map((event) => event.eventType)).not.toContain(
      "approval.approved",
    );
  });

  it("keeps a denied production request terminal for the same requestId", async () => {
    const { gateway, approvals, resources } = await makeGateway();
    const initial = await gateway.execute(context, {
      requestId: "request-denied-terminal",
      action: "deploy.production",
      resourceId: "production",
    });
    if (initial.status !== "approval_required") throw new Error("Expected approval");
    await approvals.deny(initial.approvalId, "user-a");

    const retry = await gateway.execute(context, {
      requestId: "request-denied-terminal",
      action: "deploy.production",
      resourceId: "production",
    });
    expect(retry).toMatchObject({ status: "denied", reasonCode: "approval_denied" });
    expect(await approvals.list("user-a")).toHaveLength(1);
    expect(resources.getExecutionCount("deploy.production", "production")).toBe(0);
  });
});

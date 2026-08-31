import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalService } from "./approval-service.js";
import { AuditService } from "./audit-service.js";
import {
  DEMO_REGISTERED_DESTINATIONS,
  DestinationCatalogueService,
  isRegisteredDestination,
} from "./destination-catalogue.js";
import { ServerSideCredentialBroker } from "./destination-broker.js";
import { LocalDestinationAdapter } from "./local-destination-adapter.js";
import { JsonStore, migrateDatabase } from "../store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeServices() {
  const root = await mkdtemp(path.join(tmpdir(), "nawgate-destination-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const audit = new AuditService(store);
  const approvals = new ApprovalService(store, audit);
  const catalogue = new DestinationCatalogueService(store, approvals);
  return { store, approvals, catalogue };
}

describe("DestinationCatalogueService", () => {
  it("seeds only safe server-owned destination metadata", async () => {
    const { catalogue, store } = await makeServices();
    expect(catalogue.list().map((destination) => destination.id)).toEqual([
      "tiktok-account:brand-sg",
      "tiktok-account:creator-demo",
      "analytics:approved-dashboard",
      "archive:compliance-store",
    ]);
    expect(catalogue.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "tiktok-account:brand-sg",
        organizationId: "org-user-a",
        accountId: "account-user-a",
        allowedActions: ["content.publish"],
        httpMethod: "POST",
        environment: "local",
        status: "enabled",
        revision: 1,
        credentialRef: "credential-ref:tiktok:brand-sg",
      }),
      expect.objectContaining({
        id: "analytics:approved-dashboard",
        allowedActions: ["content.disclose"],
        purposes: ["approved_analytics"],
      }),
    ]));
    expect(JSON.stringify(store.snapshot())).not.toContain(
      "SYNTHETIC_DESTINATION_SECRET_CANARY",
    );
  });

  it("rejects malformed audience, reach, and region metadata", () => {
    const destination = DEMO_REGISTERED_DESTINATIONS[0]!;
    expect(isRegisteredDestination({ ...destination, audience: "public" })).toBe(false);
    expect(isRegisteredDestination({ ...destination, reach: "unbounded" })).toBe(false);
    expect(isRegisteredDestination({ ...destination, region: "EU" })).toBe(false);
  });

  it("uses persisted catalogue metadata as authority without repopulating a v6 omission", async () => {
    const { catalogue, store } = await makeServices();
    await store.mutate((database) => {
      const destination = database.registeredDestinations.find(
        (candidate) => candidate.id === "tiktok-account:brand-sg",
      );
      if (!destination) throw new Error("Expected destination");
      destination.httpsHost = "tiktok-v2.local.test";
    });
    expect(catalogue.get("tiktok-account:brand-sg")?.httpsHost).toBe("tiktok-v2.local.test");

    const database = store.snapshot();
    database.registeredDestinations = database.registeredDestinations.filter(
      (destination) => destination.id !== "tiktok-account:brand-sg",
    );
    expect(migrateDatabase(database).registeredDestinations.map((destination) => destination.id)).not.toContain(
      "tiktok-account:brand-sg",
    );
  });

  it("injects a credential only into the trusted broker callback", async () => {
    const destination = structuredClone(
      DEMO_REGISTERED_DESTINATIONS.find((candidate) => candidate.id === "tiktok-account:brand-sg"),
    );
    if (!destination) throw new Error("Expected demo destination");
    const canary = "DESTINATION_SECRET_CANARY_TEST_ONLY";
    const broker = new ServerSideCredentialBroker(
      new Map([[destination.credentialRef, canary]]),
    );
    let observed = "";
    await expect(broker.withCredential(destination, (credential) => {
      observed = credential;
      return { status: "internal-only" };
    })).resolves.toEqual({ status: "internal-only" });
    expect(observed).toBe(canary);
  });

  it("revokes pending and approved claims when a destination changes", async () => {
    const { catalogue, approvals } = await makeServices();
    const request = {
      humanId: "user-a" as const,
      agentId: "agent-a",
      runId: "run-a",
      action: "content.publish" as const,
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
      destination: "tiktok-account:brand-sg" as const,
      destinationRevision: 1,
    };
    const pending = await approvals.getOrCreate({ ...request, requestId: "destination-pending" });
    const approved = await approvals.getOrCreate({ ...request, requestId: "destination-approved" });
    const issued = await approvals.approve(approved.id, "user-a");

    await catalogue.bumpRevision("tiktok-account:brand-sg");

    expect((await approvals.get(pending.id))?.status).toBe("revoked");
    expect((await approvals.get(approved.id))?.status).toBe("revoked");
    expect(issued.capability.remainingUses).toBe(1);
    await expect(approvals.consumeCapability({
      ...request,
      requestId: "destination-approved",
      approvalId: approved.id,
    })).resolves.toEqual({ status: "denied", reasonCode: "capability_revoked" });
  });

  it("records a safe local receipt and never persists the injected credential", async () => {
    const { catalogue, store } = await makeServices();
    const destination = catalogue.get("tiktok-account:brand-sg");
    const resource = store.snapshot().protectedResources.find(
      (candidate) => candidate.id === "asset-user-a-video-1",
    );
    if (!destination || !resource || resource.type !== "content_asset") {
      throw new Error("Expected demo destination and content asset");
    }
    const broker = new ServerSideCredentialBroker(new Map([
      [destination.credentialRef, "DESTINATION_SECRET_CANARY_TEST_ONLY"],
    ]));
    const adapter = new LocalDestinationAdapter(store, catalogue, broker);
    const receipt = await adapter.execute({
      action: "content.publish",
      resource,
      purpose: "creator_requested_publish",
      destinationId: destination.id,
      destinationRevision: destination.revision,
      resourceRevision: resource.revision,
      execution: {
        runId: "run-a",
        requestId: "destination-receipt",
        payloadDigest: "0".repeat(64),
        destination: destination.id,
        policyRevision: "bouncer-v4",
      },
    });
    expect(receipt).toMatchObject({
      destinationId: destination.id,
      action: "content.publish",
      resourceId: resource.id,
      httpsHost: "tiktok.local.test",
      httpsPath: "/v1/accounts/account-user-a/content/asset-user-a-video-1",
      credentialRef: destination.credentialRef,
    });
    const evidence = JSON.stringify(store.snapshot());
    expect(evidence).not.toContain("DESTINATION_SECRET_CANARY_TEST_ONLY");
    expect(evidence).not.toContain(resource.contentVersion + " payload");

    const missingCredentialAdapter = new LocalDestinationAdapter(
      store,
      catalogue,
      new ServerSideCredentialBroker(new Map()),
    );
    await expect(missingCredentialAdapter.execute({
      action: "content.publish",
      resource,
      purpose: "creator_requested_publish",
      destinationId: destination.id,
      destinationRevision: destination.revision,
      resourceRevision: resource.revision,
    })).rejects.toThrow("Destination credential unavailable");
    expect(store.snapshot().destinationReceipts).toHaveLength(1);
  });

  it("fails closed for destination classification and environment mismatches", async () => {
    const { catalogue, store } = await makeServices();
    const resource = store.snapshot().protectedResources.find(
      (candidate) => candidate.id === "asset-user-a-video-1",
    );
    if (!resource || resource.type !== "content_asset") throw new Error("Expected content asset");
    const operation = {
      action: "content.publish" as const,
      resource,
      purpose: "creator_requested_publish" as const,
      destinationId: "tiktok-account:brand-sg" as const,
      destinationRevision: 1,
      resourceRevision: resource.revision,
    };
    await store.mutate((database) => {
      const destination = database.registeredDestinations.find(
        (candidate) => candidate.id === operation.destinationId,
      );
      if (!destination) throw new Error("Expected destination");
      destination.classification = "sensitive";
    });
    const adapter = new LocalDestinationAdapter(
      store,
      catalogue,
      new ServerSideCredentialBroker(),
    );
    await expect(adapter.execute(operation)).rejects.toThrow("Destination classification is not allowed");

    await store.mutate((database) => {
      const destination = database.registeredDestinations.find(
        (candidate) => candidate.id === operation.destinationId,
      );
      if (!destination) throw new Error("Expected destination");
      destination.classification = "restricted";
      destination.environment = "staging" as "local";
    });
    await expect(adapter.execute(operation)).rejects.toThrow("Destination environment is not allowed");
    expect(store.snapshot().destinationReceipts).toEqual([]);
  });

  it("does not release a missing broker credential or write a receipt", async () => {
    const { catalogue, store } = await makeServices();
    const destination = catalogue.get("tiktok-account:brand-sg");
    const resource = store.snapshot().protectedResources.find(
      (candidate) => candidate.id === "asset-user-a-video-1",
    );
    if (!destination || !resource || resource.type !== "content_asset") {
      throw new Error("Expected demo destination and content asset");
    }
    const adapter = new LocalDestinationAdapter(
      store,
      catalogue,
      new ServerSideCredentialBroker(new Map()),
    );
    await expect(adapter.execute({
      action: "content.publish",
      resource,
      purpose: "creator_requested_publish",
      destinationId: destination.id,
      destinationRevision: destination.revision,
      resourceRevision: resource.revision,
    })).rejects.toThrow("Destination credential unavailable");
    expect(store.snapshot().destinationReceipts).toEqual([]);
    expect(JSON.stringify(store.snapshot())).not.toContain("DESTINATION_SECRET_CANARY");
  });
});

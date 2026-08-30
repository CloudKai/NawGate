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

const temporaryDirectories: string[] = [];
const context = { humanId: "user-a" as const, agentId: "agent-a", runId: "run-a" };

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeGateway(): Promise<{
  gateway: RuntimeGateway;
  resources: ProtectedResourceService;
  approvals: ApprovalService;
  audit: AuditService;
  store: JsonStore;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "agentgate-gateway-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
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
  const resources = new ProtectedResourceService(store);
  const audit = new AuditService(store);
  const approvals = new ApprovalService(store, audit);
  return {
    resources,
    approvals,
    audit,
    store,
    gateway: new RuntimeGateway(
      new DeterministicPolicyEngine(),
      resources,
      audit,
      approvals,
      store,
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

  it("executes an allowed staging deploy", async () => {
    const { gateway, resources } = await makeGateway();
    const result = await gateway.execute(context, {
      requestId: "request-staging",
      action: "deploy.staging",
      resourceId: "staging",
    });

    expect(result).toMatchObject({ status: "success", action: "deploy.staging" });
    expect(resources.getExecutionCount("deploy.staging", "staging")).toBe(1);
    expect(resources.getDeploymentState("staging", "staging")?.deploymentCount).toBe(1);
  });

  it("serializes duplicate requests and rejects request substitution", async () => {
    const { gateway, resources } = await makeGateway();
    const [first, second] = await Promise.all([
      gateway.execute(context, {
        requestId: "request-duplicate",
        action: "deploy.staging",
        resourceId: "staging",
      }),
      gateway.execute(context, {
        requestId: "request-duplicate",
        action: "deploy.staging",
        resourceId: "staging",
      }),
    ]);
    expect(first).toMatchObject({ status: "success" });
    expect(second).toMatchObject({ status: "success" });
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

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
          policyVersion: "bouncer-v2",
        }),
      ]),
    );
    expect(JSON.stringify(audit.list("agent-a"))).not.toContain("Synthetic internal Team Alpha file");
    expect(JSON.stringify(store.snapshot())).not.toContain("Synthetic internal Team Alpha file");
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

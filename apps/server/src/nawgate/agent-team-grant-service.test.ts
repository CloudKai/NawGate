import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import { HttpError } from "../errors.js";
import { AgentTeamGrantService } from "./agent-team-grant-service.js";
import { ApprovalService } from "./approval-service.js";
import { AuditService } from "./audit-service.js";
import { RuntimeCredentialService } from "./runtime-credential-service.js";

const temporaryDirectories: string[] = [];
const now = Date.parse("2026-08-30T12:00:00.000Z");
const actorA = { id: "user-a" as const, name: "User A" };
const actorB = { id: "user-b" as const, name: "User B" };

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService() {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-grant-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const timestamp = new Date(now).toISOString();
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
        createdAt: timestamp,
        updatedAt: timestamp,
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
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    );
  });
  const audit = new AuditService(store, () => new Date(now).toISOString());
  const approvals = new ApprovalService(store, audit, () => now);
  const credentials = new RuntimeCredentialService(() => now);
  const grants = new AgentTeamGrantService(
    store,
    approvals,
    credentials,
    audit,
    () => now,
  );
  return { store, audit, approvals, credentials, grants };
}

describe("AgentTeamGrantService", () => {
  it("lets the Agent owner who is a team admin create a narrow persistent grant", async () => {
    const { grants, audit } = await makeService();

    const grant = await grants.enroll(
      "agent-a",
      { teamId: "team-alpha", role: "viewer", expiresAt: "2026-08-31T12:00:00.000Z" },
      actorA,
    );

    expect(grant).toMatchObject({
      agentId: "agent-a",
      teamId: "team-alpha",
      role: "viewer",
      allowedActions: ["file.read"],
      status: "active",
      approvedBy: "user-a",
      bundleVersion: 1,
    });
    expect(grants.listForAgent("agent-a", actorA)).toEqual([grant]);
    expect(audit.list("agent-a")).toEqual([
      expect.objectContaining({
        eventType: "agent_grant.enrolled",
        grantId: grant.id,
        teamId: "team-alpha",
        effectiveScope: ["file.read"],
        protectedActionExecuted: false,
      }),
    ]);

    await expect(
      grants.enroll("agent-a", { teamId: "team-alpha", role: "admin" }, actorA),
    ).rejects.toMatchObject({ statusCode: 409, code: "GRANT_ALREADY_ACTIVE" });
  });

  it("requires both Agent ownership and a current team-admin relationship", async () => {
    const { grants } = await makeService();

    await expect(
      grants.enroll("agent-a", { teamId: "team-alpha", role: "viewer" }, actorB),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      grants.enroll("agent-b", { teamId: "team-alpha", role: "viewer" }, actorB),
    ).rejects.toMatchObject({ statusCode: 403, code: "TEAM_ADMIN_REQUIRED" });
    await expect(
      grants.enroll("agent-a", { teamId: "team-beta", role: "viewer" }, actorA),
    ).rejects.toMatchObject({ statusCode: 403, code: "TEAM_ADMIN_REQUIRED" });
    expect(() => grants.listForAgent("agent-a", actorB)).toThrow(HttpError);
  });

  it("rejects expired or malformed grant expiries", async () => {
    const { grants } = await makeService();

    await expect(
      grants.enroll(
        "agent-a",
        { teamId: "team-alpha", role: "viewer", expiresAt: "2026-08-30T12:00:00.000Z" },
        actorA,
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_GRANT_EXPIRY" });
    await expect(
      grants.enroll(
        "agent-a",
        { teamId: "team-alpha", role: "viewer", expiresAt: "not-a-date" },
        actorA,
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_GRANT_EXPIRY" });
  });

  it("revokes active Run authority and capabilities once, with safe grant evidence", async () => {
    const { grants, store, credentials, approvals, audit } = await makeService();
    const grant = await grants.enroll(
      "agent-a",
      { teamId: "team-alpha", role: "editor" },
      actorA,
    );
    await store.mutate((database) => {
      database.runs.push({
        id: "run-a",
        agentId: "agent-a",
        status: "running",
        prompt: "",
        output: null,
        error: null,
        usage: null,
        startedAt: new Date(now).toISOString(),
        completedAt: null,
        createdAt: new Date(now).toISOString(),
      });
    });
    const issued = credentials.issue("agent-a", "run-a", "user-a");
    const approval = await approvals.getOrCreate({
      humanId: "user-a",
      agentId: "agent-a",
      runId: "run-a",
      requestId: "request-production",
      action: "deploy.production",
      resourceId: "production",
      reasonCode: "production_deploy_requires_owner_approval",
    });
    await approvals.approve(approval.id, "user-a");

    const revoked = await grants.revoke("agent-a", grant.id, actorA);

    expect(revoked).toMatchObject({
      runsRevoked: 1,
      grant: { id: grant.id, status: "revoked" },
    });
    expect(credentials.resolve(issued.token).status).toBe("invalid");
    expect(credentials.isAuthorityRevoked("run-a")).toBe(true);
    await expect(approvals.get(approval.id)).resolves.toMatchObject({ status: "revoked" });
    expect(audit.list("agent-a")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "agent_grant.revoked",
          reasonCode: "agent_grant_revoked",
          grantId: grant.id,
          teamId: "team-alpha",
          effectiveScope: ["file.read"],
          protectedActionExecuted: false,
        }),
      ]),
    );

    await store.mutate((database) => {
      database.runs.push({
        id: "run-later",
        agentId: "agent-a",
        status: "running",
        prompt: "",
        output: null,
        error: null,
        usage: null,
        startedAt: new Date(now).toISOString(),
        completedAt: null,
        createdAt: new Date(now).toISOString(),
      });
    });
    const later = credentials.issue("agent-a", "run-later", "user-a");
    await expect(grants.revoke("agent-a", grant.id, actorA)).resolves.toMatchObject({
      runsRevoked: 0,
      grant: { status: "revoked" },
    });
    expect(credentials.resolve(later.token).status).toBe("valid");
  });
});

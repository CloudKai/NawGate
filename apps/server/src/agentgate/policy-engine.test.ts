import { describe, expect, it } from "vitest";
import { DeterministicPolicyEngine } from "./policy-engine.js";
import type { PolicyInput, ProtectedResource, TeamMembership } from "./types.js";

const projectA: ProtectedResource = {
  id: "project-a",
  type: "project_profile",
  ownerUserId: "user-a",
  classification: "sensitive",
};
const alphaInternal: ProtectedResource = {
  id: "team-alpha-internal",
  type: "team_file",
  ownerUserId: null,
  teamId: "team-alpha",
  classification: "internal",
  minimumRole: "viewer",
};
const alphaRestricted: ProtectedResource = {
  id: "team-alpha-restricted",
  type: "team_file",
  ownerUserId: null,
  teamId: "team-alpha",
  classification: "restricted",
  minimumRole: "editor",
};

function input(
  humanId: "user-a" | "user-b" = "user-a",
  resource: ProtectedResource = projectA,
  action = "resource.read",
  memberships: readonly TeamMembership[] = [],
  environment: "local" | "staging" | "production" = "local",
): PolicyInput {
  return {
    requestId: "request-a",
    subject: { humanId, agentId: "agent-a", runId: "run-a", memberships },
    object: { resource },
    action: { name: action },
    environment: { name: environment },
  };
}

describe("DeterministicPolicyEngine", () => {
  const policy = new DeterministicPolicyEngine();

  it("allows an owner to read their project profile", async () => {
    await expect(policy.evaluate(input())).resolves.toEqual({
      outcome: "allow",
      risk: "low",
      reasonCode: "owned_resource_read",
    });
  });

  it("hard-denies a cross-user resource before approval", async () => {
    await expect(policy.evaluate(input("user-a", { ...projectA, ownerUserId: "user-b" }))).resolves.toEqual({
      outcome: "deny",
      risk: "high",
      reasonCode: "resource_owner_mismatch",
    });
  });

  it("preserves staging allow and production approval semantics", async () => {
    await expect(
      policy.evaluate(input("user-a", {
        id: "staging",
        type: "deployment_target",
        ownerUserId: "user-a",
        classification: "internal",
    }, "deploy.staging", [], "staging")),
    ).resolves.toEqual({
      outcome: "allow",
      risk: "medium",
      reasonCode: "owned_staging_deploy",
    });
    await expect(
      policy.evaluate(input("user-a", {
        id: "production",
        type: "deployment_target",
        ownerUserId: "user-a",
        classification: "sensitive",
      }, "deploy.production", [], "production")),
    ).resolves.toEqual({
      outcome: "require_approval",
      risk: "high",
      reasonCode: "production_deploy_requires_owner_approval",
    });
  });

  it("allows both Alpha admin and Alpha viewer to read the internal file", async () => {
    await expect(policy.evaluate(input("user-a", alphaInternal, "file.read", [
      { teamId: "team-alpha", humanId: "user-a", role: "admin" },
    ]))).resolves.toMatchObject({ outcome: "allow", reasonCode: "team_file_read" });
    await expect(policy.evaluate(input("user-b", alphaInternal, "file.read", [
      { teamId: "team-alpha", humanId: "user-b", role: "viewer" },
    ]))).resolves.toMatchObject({ outcome: "allow", reasonCode: "team_file_read" });
  });

  it("denies a viewer from restricted Alpha and denies an absent Beta relationship", async () => {
    await expect(policy.evaluate(input("user-b", alphaRestricted, "file.read", [
      { teamId: "team-alpha", humanId: "user-b", role: "viewer" },
    ]))).resolves.toMatchObject({ outcome: "deny", reasonCode: "team_role_insufficient" });
    await expect(policy.evaluate(input("user-a", {
      id: "team-beta-internal",
      type: "team_file",
      ownerUserId: null,
      teamId: "team-beta",
      classification: "internal",
      minimumRole: "viewer",
    }, "file.read"))).resolves.toMatchObject({
      outcome: "deny",
      reasonCode: "team_membership_missing",
    });
  });

  it("fails closed on unknown teams, malformed attributes, and action/resource mismatch", async () => {
    await expect(policy.evaluate(input("user-a", {
      ...alphaInternal,
      teamId: "team-unknown",
    }, "file.read", []))).resolves.toMatchObject({ outcome: "deny", reasonCode: "unknown_team" });
    await expect(policy.evaluate({
      ...input(),
      subject: { ...input().subject, memberships: "user-supplied-role" },
    } as unknown as PolicyInput)).resolves.toMatchObject({
      outcome: "deny",
      reasonCode: "malformed_attributes",
    });
    await expect(policy.evaluate(input("user-a", alphaInternal, "resource.read"))).resolves.toMatchObject({
      outcome: "deny",
      reasonCode: "action_resource_mismatch",
    });
    await expect(policy.evaluate(input("user-a", projectA, "resource.delete"))).resolves.toMatchObject({
      outcome: "deny",
      reasonCode: "unknown_action",
    });
    await expect(policy.evaluate(undefined as unknown as PolicyInput)).resolves.toEqual({
      outcome: "deny",
      risk: "high",
      reasonCode: "invalid_context",
    });
  });
});

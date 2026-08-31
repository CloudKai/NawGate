import { describe, expect, it } from "vitest";
import { DeterministicPolicyEngine } from "./policy-engine.js";
import { demoContentScopes } from "./content-model.js";
import type {
  AgentTeamGrant,
  PolicyInput,
  ProtectedResource,
  TeamMembership,
} from "./types.js";

const alphaGrant: AgentTeamGrant = {
  id: "grant-alpha",
  agentId: "agent-a",
  teamId: "team-alpha",
  role: "admin",
  allowedActions: ["file.read"],
  status: "active",
  approvedBy: "user-a",
  expiresAt: null,
  bundleVersion: 1,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
  revokedAt: null,
};

const projectA: ProtectedResource = {
  id: "project-a",
  type: "project_profile",
  ownerUserId: "user-a",
  classification: "sensitive",
  revision: 1,
};
const alphaInternal: ProtectedResource = {
  id: "team-alpha-internal",
  type: "team_file",
  ownerUserId: null,
  teamId: "team-alpha",
  classification: "internal",
  minimumRole: "viewer",
  revision: 1,
};
const alphaRestricted: ProtectedResource = {
  id: "team-alpha-restricted",
  type: "team_file",
  ownerUserId: null,
  teamId: "team-alpha",
  classification: "restricted",
  minimumRole: "editor",
  revision: 1,
};
const contentAssetA: ProtectedResource = {
  id: "asset-user-a-video-1",
  type: "content_asset",
  ownerUserId: "user-a",
  classification: "restricted",
  revision: 1,
  organizationId: "org-user-a",
  businessCenterId: "business-center-user-a",
  accountId: "account-user-a",
  assetId: "asset-user-a-video-1",
  contentVersion: "v1",
};

function input(
  humanId: "user-a" | "user-b" = "user-a",
  resource: ProtectedResource = projectA,
  action = "resource.read",
  memberships: readonly TeamMembership[] = [],
  environment: "local" | "staging" | "production" = "local",
  agentGrants: readonly AgentTeamGrant[] = [alphaGrant],
): PolicyInput {
  return {
    requestId: "request-a",
    subject: {
      humanId,
      agentId: "agent-a",
      runId: "run-a",
      memberships,
      agentGrants,
      contentScopes: [],
    },
    object: { resource },
    action: { name: action },
    environment: { name: environment },
  };
}

describe("DeterministicPolicyEngine", () => {
  const now = Date.parse("2026-08-30T12:00:00.000Z");
  const policy = new DeterministicPolicyEngine(() => now);

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
        revision: 1,
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
        revision: 1,
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

  it("allows an editor to read restricted Alpha, but denies a viewer and an absent Beta relationship", async () => {
    await expect(policy.evaluate(input("user-a", alphaRestricted, "file.read", [
      { teamId: "team-alpha", humanId: "user-a", role: "admin" },
    ], "local", [{ ...alphaGrant, role: "editor" }]))).resolves.toMatchObject({
      outcome: "allow",
      reasonCode: "team_file_read",
    });
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
      revision: 1,
    }, "file.read"))).resolves.toMatchObject({
      outcome: "deny",
      reasonCode: "team_membership_missing",
    });
  });

  it("fails closed for missing, revoked, expired, and under-scoped Agent grants", async () => {
    const adminMembership: TeamMembership[] = [
      { teamId: "team-alpha", humanId: "user-a", role: "admin" },
    ];
    await expect(
      policy.evaluate(input("user-a", alphaInternal, "file.read", adminMembership, "local", [])),
    ).resolves.toMatchObject({ outcome: "deny", reasonCode: "agent_grant_missing" });
    await expect(
      policy.evaluate(input(
        "user-a",
        alphaInternal,
        "file.read",
        adminMembership,
        "local",
        [{ ...alphaGrant, status: "revoked", revokedAt: "2026-08-30T11:00:00.000Z" }],
      )),
    ).resolves.toMatchObject({ outcome: "deny", reasonCode: "agent_grant_revoked" });
    await expect(
      policy.evaluate(input(
        "user-a",
        alphaInternal,
        "file.read",
        adminMembership,
        "local",
        [{ ...alphaGrant, expiresAt: "2026-08-30T11:59:59.000Z" }],
      )),
    ).resolves.toMatchObject({ outcome: "deny", reasonCode: "agent_grant_expired" });
    await expect(
      policy.evaluate(input(
        "user-a",
        alphaInternal,
        "file.read",
        adminMembership,
        "local",
        [{ ...alphaGrant, allowedActions: [] }],
      )),
    ).resolves.toMatchObject({
      outcome: "deny",
      reasonCode: "agent_grant_action_under_scoped",
    });
  });

  it("requires one-use elevation when a viewer grant reads a restricted file", async () => {
    await expect(
      policy.evaluate(input(
        "user-a",
        alphaRestricted,
        "file.read",
        [{ teamId: "team-alpha", humanId: "user-a", role: "admin" }],
        "local",
        [{ ...alphaGrant, role: "viewer" }],
      )),
    ).resolves.toMatchObject({
      outcome: "require_approval",
      reasonCode: "restricted_file_requires_temporary_elevation",
    });
  });

  it("enforces typed content purpose, hierarchy, and explicit disclosure scope", async () => {
    const contentInput = (
      action: "content.moderate" | "content.disclose" | "content.publish",
      purpose: "safety_moderation" | "approved_analytics" | "creator_requested_publish",
      destination: string | null = null,
      bindingOverrides: Record<string, unknown> = {},
    ): PolicyInput => ({
      requestId: "content-request",
      subject: {
        humanId: "user-a",
        agentId: "agent-a",
        runId: "run-a",
        memberships: [],
        agentGrants: [],
        contentScopes: demoContentScopes("user-a"),
      },
      object: { resource: contentAssetA },
      action: {
        name: action,
        destination,
        contentBinding: {
          purpose,
          organizationId: "org-user-a",
          businessCenterId: "business-center-user-a",
          accountId: "account-user-a",
          assetId: "asset-user-a-video-1",
          contentVersion: "v1",
          ...bindingOverrides,
        },
      },
      environment: { name: "local" },
    });

    await expect(policy.evaluate(contentInput("content.moderate", "safety_moderation"))).resolves.toMatchObject({
      outcome: "allow",
      reasonCode: "content_moderation_allowed",
    });
    await expect(policy.evaluate(contentInput(
      "content.disclose",
      "approved_analytics",
      "analytics:account-user-a",
    ))).resolves.toMatchObject({ outcome: "allow", reasonCode: "content_disclosure_allowed" });
    await expect(policy.evaluate(contentInput(
      "content.publish",
      "creator_requested_publish",
      "tiktok:publish:account-user-a",
    ))).resolves.toMatchObject({
      outcome: "require_approval",
      reasonCode: "content_publish_requires_owner_approval",
    });
    await expect(policy.evaluate(contentInput(
      "content.moderate",
      "approved_analytics",
    ))).resolves.toMatchObject({ outcome: "deny", reasonCode: "content_purpose_mismatch" });
    await expect(policy.evaluate(contentInput(
      "content.disclose",
      "approved_analytics",
      "analytics:account-user-a",
      { assetId: "asset-user-a-video-2" },
    ))).resolves.toMatchObject({ outcome: "deny", reasonCode: "content_asset_mismatch" });
    await expect(policy.evaluate(contentInput(
      "content.disclose",
      "approved_analytics",
      "analytics:account-user-a",
      { contentVersion: "v2" },
    ))).resolves.toMatchObject({ outcome: "deny", reasonCode: "content_version_mismatch" });
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

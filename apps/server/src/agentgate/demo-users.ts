import type {
  HumanId,
  HumanPrincipal,
  ProtectedResource,
  TeamMembership,
} from "./types.js";

export const DEMO_USERS: readonly HumanPrincipal[] = [
  { id: "user-a", name: "User A" },
  { id: "user-b", name: "User B" },
];

export const DEMO_TEAM_MEMBERSHIPS: readonly TeamMembership[] = [
  { teamId: "team-alpha", humanId: "user-a", role: "admin" },
  { teamId: "team-alpha", humanId: "user-b", role: "viewer" },
  { teamId: "team-beta", humanId: "user-b", role: "editor" },
];

export const DEMO_PROTECTED_RESOURCES: readonly ProtectedResource[] = [
  {
    id: "project-a",
    type: "project_profile",
    ownerUserId: "user-a",
    classification: "sensitive",
    revision: 1,
  },
  {
    id: "project-b",
    type: "project_profile",
    ownerUserId: "user-b",
    classification: "sensitive",
    revision: 1,
  },
  {
    id: "staging",
    type: "deployment_target",
    ownerUserId: "user-a",
    classification: "internal",
    revision: 1,
  },
  {
    id: "production",
    type: "deployment_target",
    ownerUserId: "user-a",
    classification: "sensitive",
    revision: 1,
  },
  {
    id: "team-alpha-internal",
    type: "team_file",
    ownerUserId: null,
    teamId: "team-alpha",
    classification: "internal",
    minimumRole: "viewer",
    revision: 1,
  },
  {
    id: "team-alpha-restricted",
    type: "team_file",
    ownerUserId: null,
    teamId: "team-alpha",
    classification: "restricted",
    minimumRole: "editor",
    revision: 1,
  },
  {
    id: "team-beta-internal",
    type: "team_file",
    ownerUserId: null,
    teamId: "team-beta",
    classification: "internal",
    minimumRole: "viewer",
    revision: 1,
  },
  {
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
  },
  {
    id: "asset-user-a-video-2",
    type: "content_asset",
    ownerUserId: "user-a",
    classification: "sensitive",
    revision: 1,
    organizationId: "org-user-a",
    businessCenterId: "business-center-user-a",
    accountId: "account-user-a",
    assetId: "asset-user-a-video-2",
    contentVersion: "v1",
  },
  {
    id: "asset-user-b-video-1",
    type: "content_asset",
    ownerUserId: "user-b",
    classification: "restricted",
    revision: 1,
    organizationId: "org-user-b",
    businessCenterId: "business-center-user-b",
    accountId: "account-user-b",
    assetId: "asset-user-b-video-1",
    contentVersion: "v1",
  },
];

export function isHumanId(value: string): value is HumanId {
  return DEMO_USERS.some((user) => user.id === value);
}

export function isTeamId(value: string): value is "team-alpha" | "team-beta" {
  return value === "team-alpha" || value === "team-beta";
}

export function isTeamRole(value: string): value is "viewer" | "editor" | "admin" {
  return value === "viewer" || value === "editor" || value === "admin";
}

export function getDemoUser(id: string): HumanPrincipal | null {
  const user = DEMO_USERS.find((candidate) => candidate.id === id);
  return user ? { ...user } : null;
}

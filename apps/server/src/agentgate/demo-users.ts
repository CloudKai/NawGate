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
  },
  {
    id: "project-b",
    type: "project_profile",
    ownerUserId: "user-b",
    classification: "sensitive",
  },
  {
    id: "staging",
    type: "deployment_target",
    ownerUserId: "user-a",
    classification: "internal",
  },
  {
    id: "production",
    type: "deployment_target",
    ownerUserId: "user-a",
    classification: "sensitive",
  },
  {
    id: "team-alpha-internal",
    type: "team_file",
    ownerUserId: null,
    teamId: "team-alpha",
    classification: "internal",
    minimumRole: "viewer",
  },
  {
    id: "team-alpha-restricted",
    type: "team_file",
    ownerUserId: null,
    teamId: "team-alpha",
    classification: "restricted",
    minimumRole: "editor",
  },
  {
    id: "team-beta-internal",
    type: "team_file",
    ownerUserId: null,
    teamId: "team-beta",
    classification: "internal",
    minimumRole: "viewer",
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

import type { HumanId, HumanPrincipal, ProtectedResource } from "./types.js";

export const DEMO_USERS: readonly HumanPrincipal[] = [
  { id: "user-a", name: "User A" },
  { id: "user-b", name: "User B" },
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
];

export function isHumanId(value: string): value is HumanId {
  return DEMO_USERS.some((user) => user.id === value);
}

export function getDemoUser(id: string): HumanPrincipal | null {
  const user = DEMO_USERS.find((candidate) => candidate.id === id);
  return user ? { ...user } : null;
}

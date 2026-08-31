import type { JsonStore } from "../store.js";
import type { HumanId, TeamMembership } from "./types.js";

export interface MembershipResolver {
  resolveMemberships(humanId: HumanId): readonly TeamMembership[];
}

// The resolver is deliberately server-side. Runtime requests carry no team
// role claims; the gateway joins the trusted relationship tuples here before
// asking the policy engine to decide.
export class TeamMembershipService implements MembershipResolver {
  constructor(private readonly store: JsonStore) {}

  resolveMemberships(humanId: HumanId): readonly TeamMembership[] {
    return this.store
      .snapshot()
      .teamMemberships
      .filter((membership) => membership.humanId === humanId)
      .map((membership) => structuredClone(membership));
  }
}

import { HttpError } from "../errors.js";
import type { JsonStore } from "../store.js";
import { isHumanId, isTeamId } from "./demo-users.js";
import type { HumanId, HumanPrincipal, TeamId, TeamMembership, TeamRole } from "./types.js";

export interface MembershipResolver {
  resolveMemberships(humanId: HumanId): readonly TeamMembership[];
}

export interface AddTeamMembershipInput {
  memberId: HumanId;
  teamId: TeamId;
  role: TeamRole;
}

export interface RemoveTeamMembershipInput {
  memberId: HumanId;
  teamId: TeamId;
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

  async addMembership(
    input: AddTeamMembershipInput,
    actor: HumanPrincipal,
  ): Promise<TeamMembership> {
    this.requireTeamAdmin(actor.id, input.teamId);
    if (!isHumanId(input.memberId)) {
      throw new HttpError(400, "Unknown demo user", "UNKNOWN_USER");
    }

    return this.store.mutate((database) => {
      const actorMembership = database.teamMemberships.find(
        (membership) =>
          membership.humanId === actor.id && membership.teamId === input.teamId,
      );
      if (!actorMembership || actorMembership.role !== "admin") {
        throw new HttpError(403, "Current human is not a team administrator", "TEAM_ADMIN_REQUIRED");
      }

      const existing = database.teamMemberships.find(
        (membership) =>
          membership.humanId === input.memberId && membership.teamId === input.teamId,
      );
      if (existing) {
        throw new HttpError(409, "User is already a member of this team", "TEAM_MEMBERSHIP_EXISTS");
      }

      const membership: TeamMembership = {
        teamId: input.teamId,
        humanId: input.memberId,
        role: input.role,
      };
      database.teamMemberships.push(membership);
      return structuredClone(membership);
    });
  }

  resolveManageableMemberships(humanId: HumanId): readonly TeamMembership[] {
    const managedTeams = new Set(
      this.resolveMemberships(humanId)
        .filter((membership) => membership.role === "admin")
        .map((membership) => membership.teamId),
    );
    return this.store
      .snapshot()
      .teamMemberships
      .filter((membership) => managedTeams.has(membership.teamId))
      .map((membership) => structuredClone(membership));
  }

  async removeMembership(
    input: RemoveTeamMembershipInput,
    actor: HumanPrincipal,
  ): Promise<TeamMembership> {
    this.requireTeamAdmin(actor.id, input.teamId);

    return this.store.mutate((database) => {
      const actorMembership = database.teamMemberships.find(
        (membership) =>
          membership.humanId === actor.id && membership.teamId === input.teamId,
      );
      if (!actorMembership || actorMembership.role !== "admin") {
        throw new HttpError(403, "Current human is not a team administrator", "TEAM_ADMIN_REQUIRED");
      }

      const index = database.teamMemberships.findIndex(
        (membership) =>
          membership.humanId === input.memberId && membership.teamId === input.teamId,
      );
      if (index < 0) {
        throw new HttpError(404, "User is not a member of this team", "TEAM_MEMBERSHIP_NOT_FOUND");
      }

      const membership = database.teamMemberships[index];
      if (!membership) {
        throw new HttpError(404, "User is not a member of this team", "TEAM_MEMBERSHIP_NOT_FOUND");
      }
      if (membership.role === "admin") {
        const adminCount = database.teamMemberships.filter(
          (candidate) =>
            candidate.teamId === input.teamId && candidate.role === "admin",
        ).length;
        if (adminCount <= 1) {
          throw new HttpError(409, "A team must retain at least one administrator", "LAST_TEAM_ADMIN");
        }
      }

      database.teamMemberships.splice(index, 1);
      return structuredClone(membership);
    });
  }

  private requireTeamAdmin(humanId: HumanId, teamId: TeamId): void {
    if (!isTeamId(teamId)) {
      throw new HttpError(400, "Unknown team", "UNKNOWN_TEAM");
    }
    const membership = this.resolveMemberships(humanId).find(
      (candidate) => candidate.teamId === teamId,
    );
    if (!membership || membership.role !== "admin") {
      throw new HttpError(403, "Current human is not a team administrator", "TEAM_ADMIN_REQUIRED");
    }
  }
}

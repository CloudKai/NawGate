import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import type { Agent } from "../types.js";
import type { JsonStore } from "../store.js";
import { AuditService } from "./audit-service.js";
import { ApprovalService } from "./approval-service.js";
import { isTeamId } from "./demo-users.js";
import { RuntimeCredentialService } from "./runtime-credential-service.js";
import { TeamMembershipService } from "./team-membership-service.js";
import type {
  AgentTeamGrant,
  HumanPrincipal,
  TeamId,
  TeamRole,
} from "./types.js";

const GRANT_ACTIONS: ["file.read"] = ["file.read"];

export interface AgentTeamGrantInput {
  teamId: TeamId;
  role: TeamRole;
  expiresAt?: string | null | undefined;
}

export interface AgentGrantResolver {
  resolveGrants(agentId: string): readonly AgentTeamGrant[];
}

function roleRank(role: TeamRole): number {
  return role === "admin" ? 3 : role === "editor" ? 2 : 1;
}

export class AgentTeamGrantService implements AgentGrantResolver {
  private readonly memberships: TeamMembershipService;

  constructor(
    private readonly store: JsonStore,
    private readonly approvals?: ApprovalService,
    private readonly credentials?: RuntimeCredentialService,
    private readonly audit?: AuditService,
    private readonly now: () => number = Date.now,
  ) {
    this.memberships = new TeamMembershipService(store);
  }

  resolveGrants(agentId: string): readonly AgentTeamGrant[] {
    return this.store
      .snapshot()
      .agentTeamGrants
      .filter((grant) => grant.agentId === agentId)
      .map((grant) => structuredClone(grant));
  }

  listForAgent(agentId: string, actor: HumanPrincipal): AgentTeamGrant[] {
    this.requireOwnedAgent(agentId, actor);
    return [...this.resolveGrants(agentId)].sort((left, right) => {
      if (left.teamId !== right.teamId) return left.teamId.localeCompare(right.teamId);
      return right.bundleVersion - left.bundleVersion;
    });
  }

  async enroll(
    agentId: string,
    input: AgentTeamGrantInput,
    actor: HumanPrincipal,
  ): Promise<AgentTeamGrant> {
    this.requireOwnedAgent(agentId, actor);
    this.requireTeamAdmin(actor.id, input.teamId);
    const currentTime = this.now();
    if (input.expiresAt !== null && input.expiresAt !== undefined) {
      const expiry = Date.parse(input.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= currentTime) {
        throw new HttpError(400, "Grant expiry must be a valid future timestamp", "INVALID_GRANT_EXPIRY");
      }
    }

    const timestamp = new Date(currentTime).toISOString();
    return this.store.mutate((database) => {
      const agent = database.agents.find((candidate) => candidate.id === agentId);
      if (!agent || agent.ownerUserId !== actor.id) {
        throw new HttpError(404, "Agent not found");
      }
      const membership = database.teamMemberships.find(
        (candidate) => candidate.humanId === actor.id && candidate.teamId === input.teamId,
      );
      if (!membership || roleRank(membership.role) < roleRank("admin")) {
        throw new HttpError(403, "Current human is not a team administrator", "TEAM_ADMIN_REQUIRED");
      }
      const current = database.agentTeamGrants.find(
        (grant) =>
          grant.agentId === agentId &&
          grant.teamId === input.teamId &&
          grant.status === "active",
      );
      if (current) {
        throw new HttpError(409, "Agent is already enrolled in this team", "GRANT_ALREADY_ACTIVE");
      }
      const bundleVersion = database.agentTeamGrants
        .filter((grant) => grant.agentId === agentId && grant.teamId === input.teamId)
        .reduce((highest, grant) => Math.max(highest, grant.bundleVersion), 0) + 1;
      const grant: AgentTeamGrant = {
        id: randomUUID(),
        agentId,
        teamId: input.teamId,
        role: input.role,
        allowedActions: [...GRANT_ACTIONS],
        status: "active",
        approvedBy: actor.id,
        expiresAt: input.expiresAt ?? null,
        bundleVersion,
        createdAt: timestamp,
        updatedAt: timestamp,
        revokedAt: null,
      };
      database.agentTeamGrants.push(grant);
      return structuredClone(grant);
    }).then(async (grant) => {
      if (this.audit) {
        await this.audit.record({
          eventType: "agent_grant.enrolled",
          humanId: actor.id,
          agentId,
          runId: null,
          requestId: null,
          action: "file.read",
          resourceId: null,
          decision: "allow",
          risk: "medium",
          reasonCode: "team_admin_enrolled_agent",
          approvalId: null,
          capabilityId: null,
          status: "success",
          durationMs: null,
          grantId: grant.id,
          teamId: grant.teamId,
          bundleVersion: grant.bundleVersion,
          effectiveScope: [...grant.allowedActions],
          explanation: "A current team administrator enrolled the owned Agent with a narrow persistent grant.",
          enforcementPoint: "AgentTeamGrantService",
          protectedActionExecuted: false,
        });
      }
      return grant;
    });
  }

  async revoke(
    agentId: string,
    grantId: string,
    actor: HumanPrincipal,
  ): Promise<{ grant: AgentTeamGrant; runsRevoked: number }> {
    this.requireOwnedAgent(agentId, actor);
    const existing = this.store.snapshot().agentTeamGrants.find(
      (grant) => grant.id === grantId && grant.agentId === agentId,
    );
    if (!existing) throw new HttpError(404, "Team Agent grant not found");
    this.requireTeamAdmin(actor.id, existing.teamId);

    const timestamp = new Date(this.now()).toISOString();
    const outcome = await this.store.mutate((database) => {
      const agent = database.agents.find((candidate) => candidate.id === agentId);
      if (!agent || agent.ownerUserId !== actor.id) {
        throw new HttpError(404, "Agent not found");
      }
      const current = database.agentTeamGrants.find((candidate) => candidate.id === grantId);
      if (!current || current.agentId !== agentId) {
        throw new HttpError(404, "Team Agent grant not found");
      }
      const membership = database.teamMemberships.find(
        (candidate) => candidate.humanId === actor.id && candidate.teamId === current.teamId,
      );
      if (!membership || roleRank(membership.role) < roleRank("admin")) {
        throw new HttpError(403, "Current human is not a team administrator", "TEAM_ADMIN_REQUIRED");
      }
      const changed = current.status === "active";
      if (current.status === "active") {
        current.status = "revoked";
        current.revokedAt = timestamp;
        current.updatedAt = timestamp;
      }
      const activeRunIds = changed
        ? database.runs
            .filter(
              (run) =>
                run.agentId === agentId &&
                (run.status === "queued" || run.status === "running"),
            )
            .map((run) => run.id)
        : [];
      return { grant: structuredClone(current), changed, activeRunIds };
    });

    for (const runId of outcome.activeRunIds) {
      this.credentials?.revokeAuthority(runId);
      await this.approvals?.revokeForRun(runId, "agent_grant_revoked");
    }
    if (outcome.changed && this.audit) {
      await this.audit.record({
        eventType: "agent_grant.revoked",
        humanId: actor.id,
        agentId,
        runId: outcome.activeRunIds[0] ?? null,
        requestId: null,
        action: "file.read",
        resourceId: null,
        decision: "deny",
        risk: "high",
        reasonCode: "agent_grant_revoked",
        approvalId: null,
        capabilityId: null,
        status: "success",
        durationMs: null,
        grantId: outcome.grant.id,
        teamId: outcome.grant.teamId,
        bundleVersion: outcome.grant.bundleVersion,
        effectiveScope: [...outcome.grant.allowedActions],
        explanation: "A current team administrator revoked the persistent Agent grant; active Run authority and capabilities were invalidated.",
        enforcementPoint: "AgentTeamGrantService",
        protectedActionExecuted: false,
      });
    }
    return { grant: outcome.grant, runsRevoked: outcome.activeRunIds.length };
  }

  private requireOwnedAgent(agentId: string, actor: HumanPrincipal): Agent {
    const agent = this.store.snapshot().agents.find((candidate) => candidate.id === agentId);
    if (!agent || agent.ownerUserId !== actor.id) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  private requireTeamAdmin(humanId: HumanPrincipal["id"], teamId: TeamId): void {
    if (!isTeamId(teamId)) throw new HttpError(400, "Unknown team", "UNKNOWN_TEAM");
    const membership = this.memberships
      .resolveMemberships(humanId)
      .find((candidate) => candidate.teamId === teamId);
    if (!membership || roleRank(membership.role) < roleRank("admin")) {
      throw new HttpError(403, "Current human is not a team administrator", "TEAM_ADMIN_REQUIRED");
    }
  }
}

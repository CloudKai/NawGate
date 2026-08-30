import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEMO_PROTECTED_RESOURCES,
  DEMO_TEAM_MEMBERSHIPS,
  isHumanId,
  isTeamId,
  isTeamRole,
} from "./agentgate/demo-users.js";
import type {
  AgentTeamGrant,
  DeploymentState,
  TeamMembership,
} from "./agentgate/types.js";
import type { Database } from "./types.js";

const deploymentFixtures: readonly DeploymentState[] = [
  {
    resourceId: "staging",
    environment: "staging",
    deployedVersion: null,
    deploymentCount: 0,
    updatedAt: null,
  },
  {
    resourceId: "production",
    environment: "production",
    deployedVersion: null,
    deploymentCount: 0,
    updatedAt: null,
  },
];

const emptyDatabase = (): Database => seedDatabase({
  version: 4,
  agents: [],
  messages: [],
  runs: [],
  approvals: [],
  auditEvents: [],
  protectedResources: [],
  deploymentStates: [],
  actionExecutions: [],
  teamMemberships: [],
  agentTeamGrants: [],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function seedDatabase(database: Database): Database {
  for (const resource of DEMO_PROTECTED_RESOURCES) {
    if (!database.protectedResources.some((item) => item.id === resource.id)) {
      database.protectedResources.push(structuredClone(resource));
    }
  }
  for (const state of deploymentFixtures) {
    if (!database.deploymentStates.some((item) => item.resourceId === state.resourceId)) {
      database.deploymentStates.push(structuredClone(state));
    }
  }
  for (const membership of DEMO_TEAM_MEMBERSHIPS) {
    if (
      !database.teamMemberships.some(
        (item) =>
          item.teamId === membership.teamId && item.humanId === membership.humanId,
      )
    ) {
      database.teamMemberships.push(structuredClone(membership));
    }
  }
  return database;
}

function isTeamMembership(value: unknown): value is TeamMembership {
  return (
    isRecord(value) &&
    typeof value.teamId === "string" &&
    isTeamId(value.teamId) &&
    typeof value.humanId === "string" &&
    isHumanId(value.humanId) &&
    typeof value.role === "string" &&
    isTeamRole(value.role)
  );
}

function isAgentTeamGrant(value: unknown): value is AgentTeamGrant {
  const registeredActions = [
    "resource.read",
    "file.read",
    "deploy.staging",
    "deploy.production",
  ];
  return (
    isRecord(value) &&
    typeof value.id === "string" && value.id.length > 0 &&
    typeof value.agentId === "string" && value.agentId.length > 0 &&
    typeof value.teamId === "string" && isTeamId(value.teamId) &&
    typeof value.role === "string" && isTeamRole(value.role) &&
    Array.isArray(value.allowedActions) &&
    value.allowedActions.every(
      (action) => typeof action === "string" && registeredActions.includes(action),
    ) &&
    (value.status === "active" || value.status === "revoked") &&
    typeof value.approvedBy === "string" && isHumanId(value.approvedBy) &&
    (value.expiresAt === null ||
      (typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt)))) &&
    typeof value.bundleVersion === "number" &&
    Number.isInteger(value.bundleVersion) && value.bundleVersion > 0 &&
    typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)) &&
    ((value.status === "active" && value.revokedAt === null) ||
      (value.status === "revoked" &&
        typeof value.revokedAt === "string" &&
        Number.isFinite(Date.parse(value.revokedAt))))
  );
}

function isValidAgentTeamGrantSet(
  grants: readonly AgentTeamGrant[],
  agents: Database["agents"],
): boolean {
  const agentIds = new Set(agents.map((agent) => agent.id));
  const activeKeys = new Set<string>();
  const versionKeys = new Set<string>();
  for (const grant of grants) {
    const relationshipKey = `${grant.agentId}:${grant.teamId}`;
    const versionKey = `${relationshipKey}:${grant.bundleVersion}`;
    if (versionKeys.has(versionKey)) return false;
    versionKeys.add(versionKey);
    if (grant.status !== "active") continue;
    if (!agentIds.has(grant.agentId) || activeKeys.has(relationshipKey)) return false;
    activeKeys.add(relationshipKey);
  }
  return true;
}

function migrateAuditEvents(value: unknown[]): Database["auditEvents"] {
  return value.map((candidate) => {
    const event = candidate as Database["auditEvents"][number];
    const record = isRecord(candidate) ? candidate : {};
    return {
      ...event,
      grantId: typeof record.grantId === "string" ? record.grantId : null,
      teamId:
        typeof record.teamId === "string" && isTeamId(record.teamId)
          ? record.teamId
          : null,
      bundleVersion:
        typeof record.bundleVersion === "number" &&
        Number.isInteger(record.bundleVersion) &&
        record.bundleVersion > 0
          ? record.bundleVersion
          : null,
      effectiveScope:
        Array.isArray(record.effectiveScope) &&
        record.effectiveScope.every((item) => typeof item === "string")
          ? [...record.effectiveScope]
          : null,
      rejectedFieldNames:
        Array.isArray(record.rejectedFieldNames) &&
        record.rejectedFieldNames.every((item) => typeof item === "string")
          ? [...record.rejectedFieldNames]
          : null,
      humanRole:
        record.humanRole === "viewer" || record.humanRole === "editor" || record.humanRole === "admin"
          ? record.humanRole
          : null,
      agentRole:
        record.agentRole === "viewer" || record.agentRole === "editor" || record.agentRole === "admin"
          ? record.agentRole
          : null,
      resourceClassification:
        record.resourceClassification === "internal" ||
        record.resourceClassification === "sensitive" ||
        record.resourceClassification === "restricted"
          ? record.resourceClassification
          : null,
      temporaryScope:
        Array.isArray(record.temporaryScope) &&
        record.temporaryScope.every((item) => typeof item === "string")
          ? [...record.temporaryScope]
          : null,
    };
  });
}

export function migrateDatabase(value: unknown): Database {
  if (!isRecord(value) || !Array.isArray(value.agents) || !Array.isArray(value.messages) || !Array.isArray(value.runs)) {
    throw new Error("Unsupported database format");
  }

  if (value.version === 1) {
    if (!value.agents.every(isRecord)) {
      throw new Error("Unsupported database format");
    }
    return seedDatabase({
      version: 4,
      agents: value.agents.map((agent) => ({
        ...(agent as object),
        ownerUserId: "user-a",
      })) as Database["agents"],
      messages: value.messages as Database["messages"],
      runs: value.runs as Database["runs"],
      approvals: [],
      auditEvents: [],
      protectedResources: [],
      deploymentStates: [],
      actionExecutions: [],
      teamMemberships: [],
      agentTeamGrants: [],
    });
  }

  if (value.version === 2) {
    if (
      !value.agents.every(
        (agent) =>
          isRecord(agent) &&
          typeof agent.ownerUserId === "string" &&
          isHumanId(agent.ownerUserId),
      ) ||
      !Array.isArray(value.approvals) ||
      !Array.isArray(value.auditEvents) ||
      !Array.isArray(value.protectedResources) ||
      !Array.isArray(value.deploymentStates) ||
      !Array.isArray(value.actionExecutions)
    ) {
      throw new Error("Unsupported database format");
    }
    return seedDatabase({
      version: 4,
      agents: value.agents as Database["agents"],
      messages: value.messages as Database["messages"],
      runs: value.runs as Database["runs"],
      approvals: value.approvals as Database["approvals"],
      auditEvents: migrateAuditEvents(value.auditEvents),
      protectedResources: value.protectedResources as Database["protectedResources"],
      deploymentStates: value.deploymentStates as Database["deploymentStates"],
      actionExecutions: value.actionExecutions as Database["actionExecutions"],
      teamMemberships: [],
      agentTeamGrants: [],
    });
  }

  if (value.version === 3) {
    if (
      !value.agents.every(
        (agent) =>
          isRecord(agent) &&
          typeof agent.ownerUserId === "string" &&
          isHumanId(agent.ownerUserId),
      ) ||
      !Array.isArray(value.approvals) ||
      !Array.isArray(value.auditEvents) ||
      !Array.isArray(value.protectedResources) ||
      !Array.isArray(value.deploymentStates) ||
      !Array.isArray(value.actionExecutions) ||
      !Array.isArray(value.teamMemberships) ||
      !value.teamMemberships.every(isTeamMembership)
    ) {
      throw new Error("Unsupported database format");
    }
    return seedDatabase({
      version: 4,
      agents: value.agents as Database["agents"],
      messages: value.messages as Database["messages"],
      runs: value.runs as Database["runs"],
      approvals: value.approvals as Database["approvals"],
      auditEvents: migrateAuditEvents(value.auditEvents),
      protectedResources: value.protectedResources as Database["protectedResources"],
      deploymentStates: value.deploymentStates as Database["deploymentStates"],
      actionExecutions: value.actionExecutions as Database["actionExecutions"],
      teamMemberships: value.teamMemberships as Database["teamMemberships"],
      // Existing agents are never silently enrolled in a team.
      agentTeamGrants: [],
    });
  }

  if (
    value.version !== 4 ||
    !value.agents.every(
      (agent) =>
        isRecord(agent) &&
        typeof agent.ownerUserId === "string" &&
        isHumanId(agent.ownerUserId),
    ) ||
    !Array.isArray(value.approvals) ||
    !Array.isArray(value.auditEvents) ||
    !Array.isArray(value.protectedResources) ||
    !Array.isArray(value.deploymentStates) ||
    !Array.isArray(value.actionExecutions) ||
    !Array.isArray(value.teamMemberships) ||
    !value.teamMemberships.every(isTeamMembership) ||
    !Array.isArray(value.agentTeamGrants) ||
    !value.agentTeamGrants.every(isAgentTeamGrant) ||
    !isValidAgentTeamGrantSet(
      value.agentTeamGrants as AgentTeamGrant[],
      value.agents as Database["agents"],
    )
  ) {
    throw new Error("Unsupported database format");
  }

  return seedDatabase({
    ...(value as unknown as Database),
    auditEvents: migrateAuditEvents(value.auditEvents),
  });
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.data = migrateDatabase(JSON.parse(raw) as unknown);
      await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}

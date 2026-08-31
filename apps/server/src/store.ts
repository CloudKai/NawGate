import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEMO_PROTECTED_RESOURCES,
  DEMO_APPROVAL_AUTHORITIES,
  DEMO_TEAM_MEMBERSHIPS,
  isHumanId,
  isTeamId,
  isTeamRole,
} from "./nawgate/demo-users.js";
import {
  DEMO_REGISTERED_DESTINATIONS,
  isDestinationSideEffectReceipt,
  isRegisteredDestinationId,
  isRegisteredDestination,
} from "./nawgate/destination-catalogue.js";
import {
  ApprovalAuthorityService,
  isApprovalAuthorityEligible,
} from "./nawgate/approval-authority-service.js";
import type {
  AgentTeamGrant,
  NawGateAction,
  ApprovalAuthority,
  ApprovalAuthorityRole,
  ApprovalRecord,
  CapabilityClaim,
  DeploymentState,
  TeamMembership,
  RiskTier,
} from "./nawgate/types.js";
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
  version: 7,
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
  capabilityClaims: [],
  registeredDestinations: [],
  destinationReceipts: [],
  approvalAuthorities: [],
  teamRuns: [],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function seedDatabase(database: Database, seedDestinations = true): Database {
  database.teamRuns = database.teamRuns ?? [];
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
  if (seedDestinations) {
    for (const destination of DEMO_REGISTERED_DESTINATIONS) {
      if (!database.registeredDestinations.some((item) => item.id === destination.id)) {
        database.registeredDestinations.push(structuredClone(destination));
      }
    }
  }
  for (const authority of DEMO_APPROVAL_AUTHORITIES) {
    if (!database.approvalAuthorities.some((item) => item.id === authority.id)) {
      database.approvalAuthorities.push(structuredClone(authority));
    }
  }
  return invalidateStaleDestinationClaims(database);
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
    "content.moderate",
    "content.disclose",
    "content.publish",
    "content.export",
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

function migrateRegisteredDestinationsForVersion(
  value: unknown[],
  allowV6RiskMetadataMigration: boolean,
): Database["registeredDestinations"] {
  return value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Unsupported database format");
    const fixture = DEMO_REGISTERED_DESTINATIONS.find((destination) => destination.id === candidate.id);
    const migrated =
      allowV6RiskMetadataMigration &&
      candidate.audience === undefined && candidate.reach === undefined && candidate.region === undefined && fixture
        ? { ...candidate, audience: fixture.audience, reach: fixture.reach, region: fixture.region }
        : candidate;
    if (!isRegisteredDestination(migrated)) throw new Error("Unsupported database format");
    return structuredClone(migrated);
  });
}

function isApprovalAuthority(value: unknown): value is ApprovalAuthority {
  return ApprovalAuthorityService.isWellFormed(value);
}

function isValidApprovalAuthoritySet(authorities: readonly ApprovalAuthority[]): boolean {
  const ids = new Set<string>();
  const activeAssignments = new Set<string>();
  for (const authority of authorities) {
    if (!isApprovalAuthority(authority) || ids.has(authority.id)) return false;
    ids.add(authority.id);
    if (authority.status !== "active") continue;
    const assignment = [
      authority.humanId,
      authority.organizationId,
      authority.accountId ?? "*",
      authority.role,
    ].join(":");
    if (activeAssignments.has(assignment)) return false;
    activeAssignments.add(assignment);
  }
  return true;
}

function migrateAuditEvents(value: unknown[]): Database["auditEvents"] {
  return value.map((candidate) => {
    const record = isRecord(candidate) ? candidate : {};
    return {
      id: typeof record.id === "string" ? record.id : "legacy-audit-event",
      eventType: record.eventType as Database["auditEvents"][number]["eventType"],
      createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
      humanId:
        typeof record.humanId === "string" && isHumanId(record.humanId)
          ? record.humanId
          : null,
      agentId: typeof record.agentId === "string" ? record.agentId : null,
      runId: typeof record.runId === "string" ? record.runId : null,
      requestId: typeof record.requestId === "string" ? record.requestId : null,
      action:
        typeof record.action === "string"
          ? record.action as Database["auditEvents"][number]["action"]
          : null,
      resourceId: typeof record.resourceId === "string" ? record.resourceId : null,
      decision:
        record.decision === "allow" ||
        record.decision === "deny" ||
        record.decision === "require_approval"
          ? record.decision
          : null,
      risk:
        record.risk === "low" || record.risk === "medium" || record.risk === "high" || record.risk === "critical"
          ? record.risk
          : null,
      reasonCode: typeof record.reasonCode === "string" ? record.reasonCode : null,
      approvalId: typeof record.approvalId === "string" ? record.approvalId : null,
      capabilityId: typeof record.capabilityId === "string" ? record.capabilityId : null,
      status:
        record.status === "success" || record.status === "failure" || record.status === "pending"
          ? record.status
          : "failure",
      durationMs: typeof record.durationMs === "number" ? record.durationMs : null,
      policyVersion: typeof record.policyVersion === "string" ? record.policyVersion : null,
      explanation: typeof record.explanation === "string" ? record.explanation : null,
      enforcementPoint:
        typeof record.enforcementPoint === "string" ? record.enforcementPoint : null,
      protectedActionExecuted:
        typeof record.protectedActionExecuted === "boolean"
          ? record.protectedActionExecuted
          : null,
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
      riskVersion: typeof record.riskVersion === "string" ? record.riskVersion : null,
      riskFactsDigest: isPayloadDigest(record.riskFactsDigest) ? record.riskFactsDigest : null,
      requiredApprovalCount:
        typeof record.requiredApprovalCount === "number" &&
        Number.isInteger(record.requiredApprovalCount) &&
        record.requiredApprovalCount > 0
          ? record.requiredApprovalCount
          : null,
      requiredApprovalRoles:
        Array.isArray(record.requiredApprovalRoles) &&
        record.requiredApprovalRoles.every((role) => role === "owner" || role === "independent_reviewer")
          ? [...record.requiredApprovalRoles]
          : null,
      approvalDecisions: Array.isArray(record.approvalDecisions)
        ? record.approvalDecisions.flatMap((decision) => {
            if (!isRecord(decision)) return [];
            if (
              typeof decision.humanId !== "string" || !isHumanId(decision.humanId) ||
              typeof decision.authorityId !== "string" || decision.authorityId.length === 0 ||
              typeof decision.authorityRevision !== "number" || !Number.isInteger(decision.authorityRevision) ||
              (decision.role !== "owner" && decision.role !== "independent_reviewer") ||
              (decision.decision !== "approve" && decision.decision !== "deny") ||
              typeof decision.decidedAt !== "string" || !Number.isFinite(Date.parse(decision.decidedAt))
            ) return [];
            return [{
              humanId: decision.humanId,
              authorityId: decision.authorityId,
              authorityRevision: decision.authorityRevision,
              role: decision.role,
              decision: decision.decision,
              decidedAt: decision.decidedAt,
            }];
          })
        : null,
    };
  });
}

function migrateProtectedResources(value: unknown[]): Database["protectedResources"] {
  return value.map((candidate) => {
    if (!isRecord(candidate)) return candidate as Database["protectedResources"][number];
    if (
      candidate.type === "content_asset" &&
      (candidate.assetType !== "short_video" ||
        (candidate.sourceRegion !== "SG" && candidate.sourceRegion !== "GLOBAL"))
    ) {
      throw new Error("Unsupported database format");
    }
    const revision =
      typeof candidate.revision === "number" &&
      Number.isInteger(candidate.revision) &&
      candidate.revision > 0
        ? candidate.revision
        : 1;
    return {
      ...candidate,
      revision,
    } as Database["protectedResources"][number];
  });
}

function isPayloadDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isValidApprovalRequirement(
  risk: RiskTier,
  count: number,
  roles: readonly ApprovalAuthorityRole[],
): boolean {
  return risk === "critical"
    ? count === 2 && roles.length === 2 && roles[0] === "owner" && roles[1] === "independent_reviewer"
    : count === 1 && roles.length === 1 && roles[0] === "owner";
}

function isRegisteredAction(value: unknown): value is NawGateAction {
  return value === "resource.read" ||
    value === "file.read" ||
    value === "deploy.staging" ||
    value === "deploy.production" ||
    value === "content.moderate" ||
    value === "content.disclose" ||
    value === "content.publish" ||
    value === "content.export";
}

function safeExecutionSummary(value: unknown): unknown {
  if (!isRecord(value) || typeof value.summary !== "string" || value.summary.length > 240) {
    return undefined;
  }
  const summary: { summary: string; destinationReceiptId?: string } = {
    summary: value.summary,
  };
  if (
    typeof value.destinationReceiptId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.destinationReceiptId,
    )
  ) {
    summary.destinationReceiptId = value.destinationReceiptId;
  }
  return summary;
}

function migrateApprovals(value: unknown[]): Database["approvals"] {
  return value.map((candidate) => {
    const record = isRecord(candidate) ? candidate : {};
    const destination = record.destination === null || typeof record.destination === "string"
      ? record.destination
      : null;
    const destinationRevision = record.destinationRevision;
    const contentDestinationBinding =
      record.action === "content.moderate"
        ? destination === null && destinationRevision === null
        : record.action === "content.disclose" ||
            record.action === "content.publish" ||
            record.action === "content.export"
          ? isRegisteredDestinationId(destination) &&
            typeof destinationRevision === "number" &&
            Number.isInteger(destinationRevision) &&
            destinationRevision > 0
          : true;
    const riskTier = record.risk === "low" || record.risk === "medium" || record.risk === "high" || record.risk === "critical"
      ? record.risk
      : "critical";
    const requiredApprovalRoles = Array.isArray(record.requiredApprovalRoles) &&
      record.requiredApprovalRoles.every((role) => role === "owner" || role === "independent_reviewer")
      ? [...record.requiredApprovalRoles] as ApprovalRecord["requiredApprovalRoles"]
      : [];
    const validApprovalDecisions = Array.isArray(record.approvalDecisions) && record.approvalDecisions.every((decision) =>
      isRecord(decision) &&
      typeof decision.humanId === "string" && isHumanId(decision.humanId) &&
      typeof decision.authorityId === "string" && decision.authorityId.length > 0 &&
      typeof decision.authorityRevision === "number" && Number.isInteger(decision.authorityRevision) && decision.authorityRevision > 0 &&
      (decision.role === "owner" || decision.role === "independent_reviewer") &&
      (decision.decision === "approve" || decision.decision === "deny") &&
      typeof decision.decidedAt === "string" && Number.isFinite(Date.parse(decision.decidedAt))
    )
      ? (record.approvalDecisions as unknown[]).map((candidate) => {
          const decision = candidate as Record<string, unknown>;
          return {
            humanId: decision.humanId as ApprovalRecord["requesterHumanId"],
            authorityId: decision.authorityId as string,
            authorityRevision: decision.authorityRevision as number,
            role: decision.role as ApprovalRecord["requiredApprovalRoles"][number],
            decision: decision.decision as "approve" | "deny",
            decidedAt: decision.decidedAt as string,
          };
        })
      : false;
    const approvalDecisions: ApprovalRecord["approvalDecisions"] = validApprovalDecisions === false
      ? []
      : validApprovalDecisions;
    const requiredApprovalCount =
      typeof record.requiredApprovalCount === "number" &&
      Number.isInteger(record.requiredApprovalCount) &&
      record.requiredApprovalCount > 0
        ? record.requiredApprovalCount
        : 0;
    const approvalStatus =
      record.status === "pending" ||
      record.status === "approved" ||
      record.status === "denied" ||
      record.status === "expired" ||
      record.status === "consumed" ||
      record.status === "revoked"
        ? record.status
        : "revoked";
    const decisionsMatchRoles =
      validApprovalDecisions !== false &&
      new Set(approvalDecisions.map((decision) => decision.humanId)).size === approvalDecisions.length &&
      new Set(approvalDecisions.map((decision) => decision.authorityId)).size === approvalDecisions.length &&
      new Set(approvalDecisions.map((decision) => decision.role)).size === approvalDecisions.length &&
      approvalDecisions.every((decision, index) => decision.role === requiredApprovalRoles[index]);
    const requesterHumanId = isHumanId(record.requesterHumanId as string)
      ? record.requesterHumanId
      : isHumanId(record.humanId as string)
        ? record.humanId
        : "user-a";
    const organizationId = typeof record.organizationId === "string" && record.organizationId.length > 0
      ? record.organizationId
      : "unknown";
    const accountId = record.accountId === null || (typeof record.accountId === "string" && record.accountId.length > 0)
      ? record.accountId
      : null;
    const hasBinding =
      isRegisteredAction(record.action) &&
      typeof record.id === "string" && record.id.length > 0 &&
      isHumanId(record.humanId as string) &&
      typeof record.agentId === "string" && record.agentId.length > 0 &&
      typeof record.runId === "string" && record.runId.length > 0 &&
      typeof record.requestId === "string" && record.requestId.length > 0 &&
      typeof record.resourceId === "string" && record.resourceId.length > 0 &&
      isPayloadDigest(record.payloadDigest) &&
      (record.destination === null || typeof record.destination === "string") &&
      typeof record.policyRevision === "string" &&
      record.policyRevision.length > 0 &&
      typeof record.resourceRevision === "number" &&
      Number.isInteger(record.resourceRevision) &&
      record.resourceRevision > 0 &&
      contentDestinationBinding &&
      typeof record.riskVersion === "string" && record.riskVersion.length > 0 &&
      isPayloadDigest(record.riskFactsDigest) &&
      requiredApprovalCount > 0 &&
      isValidApprovalRequirement(riskTier, requiredApprovalCount, requiredApprovalRoles) &&
      Array.isArray(record.approvalDecisions) &&
      validApprovalDecisions !== false &&
      approvalDecisions.length <= requiredApprovalCount &&
      decisionsMatchRoles &&
      (approvalStatus !== "approved" && approvalStatus !== "consumed" ||
        (approvalDecisions.length === requiredApprovalCount &&
          approvalDecisions.every((decision) => decision.decision === "approve"))) &&
      typeof record.requesterHumanId === "string" && isHumanId(record.requesterHumanId) &&
      typeof record.organizationId === "string" && record.organizationId.length > 0 &&
      (record.accountId === null || (typeof record.accountId === "string" && record.accountId.length > 0));
    const approval = {
      id: typeof record.id === "string" ? record.id : "legacy-approval",
      humanId: isHumanId(record.humanId as string) ? record.humanId : "user-a",
      agentId: typeof record.agentId === "string" ? record.agentId : "legacy-agent",
      runId: typeof record.runId === "string" ? record.runId : "legacy-run",
      requestId: typeof record.requestId === "string" ? record.requestId : "legacy-request",
      action: record.action,
      resourceId: typeof record.resourceId === "string" ? record.resourceId : "legacy-resource",
      risk: riskTier,
      reasonCode: typeof record.reasonCode === "string" ? record.reasonCode : "legacy_unbound_approval",
      status: approvalStatus,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
      decidedAt: typeof record.decidedAt === "string" ? record.decidedAt : null,
      expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : new Date(0).toISOString(),
      payloadDigest: hasBinding ? record.payloadDigest : null,
      destination: hasBinding ? destination : null,
      policyRevision: hasBinding ? record.policyRevision : null,
      resourceRevision: hasBinding ? record.resourceRevision : null,
      destinationRevision: hasBinding &&
        (destinationRevision === null ||
          (typeof destinationRevision === "number" &&
            Number.isInteger(destinationRevision) &&
            destinationRevision > 0))
        ? destinationRevision
        : null,
      requesterHumanId,
      riskVersion: typeof record.riskVersion === "string" && record.riskVersion.length > 0
        ? record.riskVersion
        : "legacy-unbound",
      riskFactsDigest: isPayloadDigest(record.riskFactsDigest)
        ? record.riskFactsDigest
        : "0".repeat(64),
      requiredApprovalCount: requiredApprovalCount || 1,
      requiredApprovalRoles: requiredApprovalRoles.length > 0 ? requiredApprovalRoles : ["owner"],
      approvalDecisions,
      organizationId,
      accountId,
      // Legacy approvals have no proof of the exact operation they authorized.
      // Preserve them as terminal records so restart cannot make them usable.
      ...(hasBinding
        ? {}
        : {
            status: "revoked",
            decidedAt:
              typeof record.decidedAt === "string"
                ? record.decidedAt
                : typeof record.createdAt === "string"
                  ? record.createdAt
                  : null,
            reasonCode: "legacy_unbound_approval",
          }),
    } as Database["approvals"][number];
    return approval;
  });
}

function migrateActionExecutions(value: unknown[]): Database["actionExecutions"] {
  return value.flatMap((candidate) => {
    const record = isRecord(candidate) ? candidate : {};
    if (
      typeof record.runId !== "string" ||
      typeof record.requestId !== "string" ||
      typeof record.action !== "string" ||
      typeof record.resourceId !== "string" ||
      (record.status !== "succeeded" && record.status !== "failed") ||
      typeof record.completedAt !== "string"
    ) {
      return [];
    }
    return {
      runId: record.runId,
      requestId: record.requestId,
      action: record.action,
      resourceId: record.resourceId,
      payloadDigest: isPayloadDigest(record.payloadDigest) ? record.payloadDigest : null,
      destination: typeof record.destination === "string" ? record.destination : null,
      policyRevision:
        typeof record.policyRevision === "string" && record.policyRevision.length > 0
          ? record.policyRevision
          : null,
      resourceRevision:
        typeof record.resourceRevision === "number" &&
        Number.isInteger(record.resourceRevision) &&
        record.resourceRevision > 0
          ? record.resourceRevision
          : null,
      destinationRevision:
        typeof record.destinationRevision === "number" &&
        Number.isInteger(record.destinationRevision) &&
        record.destinationRevision > 0
          ? record.destinationRevision
          : null,
      requesterHumanId:
        typeof record.requesterHumanId === "string" && isHumanId(record.requesterHumanId)
          ? record.requesterHumanId
          : null,
      organizationId: typeof record.organizationId === "string" ? record.organizationId : null,
      accountId:
        record.accountId === null || typeof record.accountId === "string"
          ? record.accountId
          : null,
      risk:
        record.risk === "low" || record.risk === "medium" || record.risk === "high" || record.risk === "critical"
          ? record.risk
          : null,
      riskVersion: typeof record.riskVersion === "string" ? record.riskVersion : null,
      riskFactsDigest: isPayloadDigest(record.riskFactsDigest) ? record.riskFactsDigest : null,
      requiredApprovalCount:
        typeof record.requiredApprovalCount === "number" &&
        Number.isInteger(record.requiredApprovalCount) &&
        record.requiredApprovalCount > 0
          ? record.requiredApprovalCount
          : null,
      requiredApprovalRoles:
        Array.isArray(record.requiredApprovalRoles) &&
        record.requiredApprovalRoles.every((role) => role === "owner" || role === "independent_reviewer")
          ? [...record.requiredApprovalRoles]
          : null,
      approvalDecisions: Array.isArray(record.approvalDecisions)
        ? record.approvalDecisions.flatMap((decision) => {
            if (!isRecord(decision)) return [];
            if (
              typeof decision.humanId !== "string" || !isHumanId(decision.humanId) ||
              typeof decision.authorityId !== "string" || decision.authorityId.length === 0 ||
              typeof decision.authorityRevision !== "number" || !Number.isInteger(decision.authorityRevision) ||
              (decision.role !== "owner" && decision.role !== "independent_reviewer") ||
              decision.decision !== "approve" ||
              typeof decision.decidedAt !== "string" || !Number.isFinite(Date.parse(decision.decidedAt))
            ) return [];
            return [{
              humanId: decision.humanId,
              authorityId: decision.authorityId,
              authorityRevision: decision.authorityRevision,
              role: decision.role,
              decision: "approve" as const,
              decidedAt: decision.decidedAt,
            }];
          })
        : null,
      ...(typeof record.destinationReceiptId === "string" ? { destinationReceiptId: record.destinationReceiptId } : {}),
      status: record.status,
      ...(safeExecutionSummary(record.resultSummary) !== undefined
        ? { resultSummary: safeExecutionSummary(record.resultSummary) }
        : {}),
      completedAt: record.completedAt,
    } as Database["actionExecutions"][number];
  });
}

function isCapabilityClaim(value: unknown): value is CapabilityClaim {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set([
    "id", "approvalId", "humanId", "agentId", "runId", "action", "resourceId",
    "requestId", "issuedAt", "expiresAt", "remainingUses", "payloadDigest",
    "destination", "policyRevision", "resourceRevision", "destinationRevision",
    "grantId", "teamId", "bundleVersion", "effectiveScope", "humanRole",
    "agentRole", "resourceClassification", "temporaryScope", "risk", "riskVersion",
    "riskFactsDigest", "requiredApprovalCount", "requiredApprovalRoles", "approvalDecisions",
    "requesterHumanId", "organizationId", "accountId",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  return (
    typeof value.id === "string" && value.id.length > 0 &&
    typeof value.approvalId === "string" && value.approvalId.length > 0 &&
    typeof value.humanId === "string" && isHumanId(value.humanId) &&
    typeof value.agentId === "string" && value.agentId.length > 0 &&
    typeof value.runId === "string" && value.runId.length > 0 &&
    typeof value.action === "string" &&
      [
        "resource.read",
        "file.read",
        "deploy.staging",
        "deploy.production",
        "content.moderate",
        "content.disclose",
        "content.publish",
        "content.export",
      ].includes(value.action) &&
    typeof value.resourceId === "string" && value.resourceId.length > 0 &&
    typeof value.requestId === "string" && value.requestId.length > 0 &&
    isPayloadDigest(value.payloadDigest) &&
    (value.destination === null || typeof value.destination === "string") &&
    typeof value.policyRevision === "string" && value.policyRevision.length > 0 &&
    typeof value.resourceRevision === "number" &&
      Number.isInteger(value.resourceRevision) && value.resourceRevision > 0 &&
    (value.destinationRevision === null ||
      (typeof value.destinationRevision === "number" &&
        Number.isInteger(value.destinationRevision) &&
        value.destinationRevision > 0)) &&
    typeof value.issuedAt === "string" && Number.isFinite(Date.parse(value.issuedAt)) &&
    typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt)) &&
    (value.remainingUses === 0 || value.remainingUses === 1) &&
    (value.risk === "low" || value.risk === "medium" || value.risk === "high" || value.risk === "critical") &&
    typeof value.riskVersion === "string" && value.riskVersion.length > 0 &&
    isPayloadDigest(value.riskFactsDigest) &&
    typeof value.requiredApprovalCount === "number" && Number.isInteger(value.requiredApprovalCount) && value.requiredApprovalCount > 0 &&
    Array.isArray(value.requiredApprovalRoles) &&
      value.requiredApprovalRoles.every((role) => role === "owner" || role === "independent_reviewer") &&
      isValidApprovalRequirement(value.risk, value.requiredApprovalCount, value.requiredApprovalRoles) &&
    Array.isArray(value.approvalDecisions) && value.approvalDecisions.length === value.requiredApprovalCount &&
      new Set(value.approvalDecisions.map((decision) => isRecord(decision) ? decision.humanId : undefined)).size === value.approvalDecisions.length &&
      new Set(value.approvalDecisions.map((decision) => isRecord(decision) ? decision.authorityId : undefined)).size === value.approvalDecisions.length &&
      new Set(value.approvalDecisions.map((decision) => isRecord(decision) ? decision.role : undefined)).size === value.approvalDecisions.length &&
      value.approvalDecisions.every((decision) =>
        isRecord(decision) && typeof decision.humanId === "string" && isHumanId(decision.humanId) &&
        typeof decision.authorityId === "string" && decision.authorityId.length > 0 &&
        typeof decision.authorityRevision === "number" && Number.isInteger(decision.authorityRevision) && decision.authorityRevision > 0 &&
        (decision.role === "owner" || decision.role === "independent_reviewer") &&
        decision.decision === "approve" && typeof decision.decidedAt === "string" && Number.isFinite(Date.parse(decision.decidedAt)),
      ) &&
      value.approvalDecisions.every((decision, index) =>
        isRecord(decision) && decision.role === (value.requiredApprovalRoles as unknown[])[index],
      ) &&
    typeof value.requesterHumanId === "string" && isHumanId(value.requesterHumanId) &&
    typeof value.organizationId === "string" && value.organizationId.length > 0 &&
    (value.accountId === null || (typeof value.accountId === "string" && value.accountId.length > 0)) &&
    (value.grantId === undefined || typeof value.grantId === "string") &&
    (value.teamId === undefined || (typeof value.teamId === "string" && isTeamId(value.teamId))) &&
    (value.bundleVersion === undefined || (typeof value.bundleVersion === "number" && Number.isInteger(value.bundleVersion) && value.bundleVersion > 0)) &&
    (value.effectiveScope === undefined || (Array.isArray(value.effectiveScope) && value.effectiveScope.every((item) => typeof item === "string"))) &&
    (value.humanRole === undefined || (typeof value.humanRole === "string" && isTeamRole(value.humanRole))) &&
    (value.agentRole === undefined || (typeof value.agentRole === "string" && isTeamRole(value.agentRole))) &&
    (value.resourceClassification === undefined || value.resourceClassification === "internal" || value.resourceClassification === "sensitive" || value.resourceClassification === "restricted") &&
    (value.temporaryScope === undefined || (Array.isArray(value.temporaryScope) && value.temporaryScope.every((item) => typeof item === "string"))) &&
    (value.action === "content.moderate"
      ? value.destination === null && value.destinationRevision === null
      : value.action === "content.disclose" || value.action === "content.publish" || value.action === "content.export"
        ? isRegisteredDestinationId(value.destination) && value.destinationRevision !== null
        : true)
  );
}

function claimMatchesApproval(approval: ApprovalRecord, claim: CapabilityClaim): boolean {
  return (
    claim.approvalId === approval.id &&
    claim.humanId === approval.humanId &&
    claim.agentId === approval.agentId &&
    claim.runId === approval.runId &&
    claim.requestId === approval.requestId &&
    claim.action === approval.action &&
    claim.resourceId === approval.resourceId &&
    claim.payloadDigest === approval.payloadDigest &&
    claim.destination === approval.destination &&
    claim.policyRevision === approval.policyRevision &&
    claim.resourceRevision === approval.resourceRevision &&
    claim.destinationRevision === approval.destinationRevision &&
    claim.requesterHumanId === approval.requesterHumanId &&
    claim.risk === approval.risk &&
    claim.riskVersion === approval.riskVersion &&
    claim.riskFactsDigest === approval.riskFactsDigest &&
    claim.requiredApprovalCount === approval.requiredApprovalCount &&
    JSON.stringify(claim.requiredApprovalRoles) === JSON.stringify(approval.requiredApprovalRoles) &&
    JSON.stringify(claim.approvalDecisions) === JSON.stringify(approval.approvalDecisions) &&
    claim.organizationId === approval.organizationId &&
    claim.accountId === approval.accountId &&
    (claim.grantId ?? null) === (approval.grantId ?? null) &&
    (claim.teamId ?? null) === (approval.teamId ?? null) &&
    (claim.bundleVersion ?? null) === (approval.bundleVersion ?? null) &&
    JSON.stringify(claim.effectiveScope ?? null) === JSON.stringify(approval.effectiveScope ?? null) &&
    (claim.humanRole ?? null) === (approval.humanRole ?? null) &&
    (claim.agentRole ?? null) === (approval.agentRole ?? null) &&
    (claim.resourceClassification ?? null) === (approval.resourceClassification ?? null) &&
    JSON.stringify(claim.temporaryScope ?? null) === JSON.stringify(approval.temporaryScope ?? null)
  );
}

function approvalDecisionsHaveCurrentAuthorities(
  approval: ApprovalRecord,
  authorities: readonly ApprovalAuthority[],
): boolean {
  return approval.approvalDecisions.every((decision) => {
    const authority = authorities.find((candidate) => candidate.id === decision.authorityId);
    return Boolean(
      authority &&
      authority.revision === decision.authorityRevision &&
      isApprovalAuthorityEligible(authority, {
        humanId: decision.humanId,
        organizationId: approval.organizationId,
        accountId: approval.accountId,
        action: approval.action,
        riskTier: approval.risk,
        role: decision.role,
      }),
    );
  });
}

function migrateCapabilityClaims(
  value: unknown,
  approvals: readonly ApprovalRecord[],
  authorities: readonly ApprovalAuthority[],
): Database["capabilityClaims"] {
  if (!Array.isArray(value)) return [];
  // A malformed or legacy claim is intentionally discarded. Its associated
  // approval remains non-usable because consumption requires a valid claim.
  return value
    .filter(isCapabilityClaim)
    .filter((claim) => {
      const approval = approvals.find((candidate) => candidate.id === claim.approvalId);
      if (!approval || (approval.status !== "approved" && approval.status !== "consumed")) return false;
      return (
        claimMatchesApproval(approval, claim) &&
        approvalDecisionsHaveCurrentAuthorities(approval, authorities) &&
        ((approval.status === "approved" && claim.remainingUses === 1) ||
          (approval.status === "consumed" && claim.remainingUses === 0))
      );
    })
    .map((claim) => structuredClone(claim));
}

function reconcileApprovalClaims(
  approvals: ApprovalRecord[],
  claims: CapabilityClaim[],
  authorities: readonly ApprovalAuthority[],
): void {
  for (const approval of approvals) {
    if (
      (approval.status === "pending" || approval.status === "approved") &&
      !approvalDecisionsHaveCurrentAuthorities(approval, authorities)
    ) {
      approval.status = "revoked";
      approval.reasonCode = "approval_authority_revoked";
      approval.decidedAt = approval.decidedAt ?? approval.createdAt;
      const staleClaim = claims.find((candidate) => candidate.approvalId === approval.id);
      if (staleClaim) staleClaim.remainingUses = 0;
      continue;
    }
    if (approval.status !== "approved" && approval.status !== "consumed") continue;
    const claim = claims.find((candidate) => candidate.approvalId === approval.id);
    const valid = approvalDecisionsHaveCurrentAuthorities(approval, authorities) &&
      claim !== undefined && claimMatchesApproval(approval, claim) &&
      ((approval.status === "approved" && claim.remainingUses === 1) ||
        (approval.status === "consumed" && claim.remainingUses === 0));
    if (valid) continue;
    approval.status = "revoked";
    approval.reasonCode = "legacy_unbound_approval";
    approval.decidedAt = approval.decidedAt ?? approval.createdAt;
    if (claim) claim.remainingUses = 0;
  }
}

function destinationInvalidationReason(
  database: Database,
  destinationId: unknown,
  destinationRevision: unknown,
): string | null {
  if (!isRegisteredDestinationId(destinationId)) return "content_destination_unknown";
  const destination = database.registeredDestinations.find(
    (candidate) => candidate.id === destinationId && isRegisteredDestination(candidate),
  );
  if (!destination) return "content_destination_unknown";
  if (destination.status === "disabled") return "content_destination_disabled";
  if (destination.status === "revoked") return "content_destination_revoked";
  if (destinationRevision !== destination.revision) return "destination_revision_changed";
  return null;
}

function invalidateStaleDestinationClaims(database: Database): Database {
  const claimsByApproval = new Map(
    database.capabilityClaims.map((claim) => [claim.approvalId, claim]),
  );
  for (const approval of database.approvals) {
    if (
      approval.action !== "content.disclose" &&
      approval.action !== "content.publish" &&
      approval.action !== "content.export"
    ) {
      continue;
    }
    const reasonCode = destinationInvalidationReason(
      database,
      approval.destination,
      approval.destinationRevision,
    );
    if (!reasonCode) continue;
    const claim = claimsByApproval.get(approval.id);
    if (claim) claim.remainingUses = 0;
    if (approval.status === "pending" || approval.status === "approved") {
      approval.status = "revoked";
      approval.reasonCode = reasonCode;
      approval.decidedAt = new Date().toISOString();
    }
  }
  for (const claim of database.capabilityClaims) {
    if (
      claim.action !== "content.disclose" &&
      claim.action !== "content.publish" &&
      claim.action !== "content.export"
    ) {
      continue;
    }
    if (destinationInvalidationReason(database, claim.destination, claim.destinationRevision)) {
      claim.remainingUses = 0;
    }
  }
  return database;
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
      version: 7,
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
      capabilityClaims: [],
      registeredDestinations: [],
      destinationReceipts: [],
      approvalAuthorities: [],
      teamRuns: [],
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
      version: 7,
      agents: value.agents as Database["agents"],
      messages: value.messages as Database["messages"],
      runs: value.runs as Database["runs"],
      approvals: migrateApprovals(value.approvals),
      auditEvents: migrateAuditEvents(value.auditEvents),
      protectedResources: migrateProtectedResources(value.protectedResources),
      deploymentStates: value.deploymentStates as Database["deploymentStates"],
      actionExecutions: migrateActionExecutions(value.actionExecutions),
      teamMemberships: [],
      agentTeamGrants: [],
      capabilityClaims: [],
      registeredDestinations: [],
      destinationReceipts: [],
      approvalAuthorities: [],
      teamRuns: [],
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
      version: 7,
      agents: value.agents as Database["agents"],
      messages: value.messages as Database["messages"],
      runs: value.runs as Database["runs"],
      approvals: migrateApprovals(value.approvals),
      auditEvents: migrateAuditEvents(value.auditEvents),
      protectedResources: migrateProtectedResources(value.protectedResources),
      deploymentStates: value.deploymentStates as Database["deploymentStates"],
      actionExecutions: migrateActionExecutions(value.actionExecutions),
      teamMemberships: value.teamMemberships as Database["teamMemberships"],
      // Existing agents are never silently enrolled in a team.
      agentTeamGrants: [],
      capabilityClaims: [],
      registeredDestinations: [],
      destinationReceipts: [],
      approvalAuthorities: [],
      teamRuns: [],
    });
  }

  if (value.version === 4) {
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
      version: 7,
      agents: value.agents as Database["agents"],
      messages: value.messages as Database["messages"],
      runs: value.runs as Database["runs"],
      approvals: migrateApprovals(value.approvals),
      auditEvents: migrateAuditEvents(value.auditEvents),
      protectedResources: migrateProtectedResources(value.protectedResources),
      deploymentStates: value.deploymentStates as Database["deploymentStates"],
      actionExecutions: migrateActionExecutions(value.actionExecutions),
      teamMemberships: value.teamMemberships as Database["teamMemberships"],
      agentTeamGrants: value.agentTeamGrants as Database["agentTeamGrants"],
      capabilityClaims: [],
      registeredDestinations: [],
      destinationReceipts: [],
      approvalAuthorities: [],
      teamRuns: [],
    });
  }

  if (
    (value.version !== 5 && value.version !== 6 && value.version !== 7) ||
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
    !Array.isArray(value.capabilityClaims) ||
    ((value.version === 6 || value.version === 7) && !Array.isArray(value.registeredDestinations)) ||
    ((value.version === 6 || value.version === 7) && !Array.isArray(value.destinationReceipts)) ||
    (value.version === 6 &&
      !((value.registeredDestinations as unknown[]).every((destination) =>
        migrateRegisteredDestinationsForVersion([destination], true).length === 1))) ||
    (value.version === 7 &&
      !((value.registeredDestinations as unknown[]).every((destination) =>
        migrateRegisteredDestinationsForVersion([destination], false).length === 1))) ||
    ((value.version === 6 || value.version === 7) &&
      !(value.destinationReceipts as unknown[]).every(isDestinationSideEffectReceipt)) ||
    (value.version === 7 && !Array.isArray(value.approvalAuthorities)) ||
    (value.version === 7 &&
      !isValidApprovalAuthoritySet(value.approvalAuthorities as ApprovalAuthority[])) ||
    !isValidAgentTeamGrantSet(
      value.agentTeamGrants as AgentTeamGrant[],
      value.agents as Database["agents"],
    )
  ) {
    throw new Error("Unsupported database format");
  }

  const approvals = migrateApprovals(value.approvals);
  const authorities = value.version === 7
    ? value.approvalAuthorities as Database["approvalAuthorities"]
    : [];
  const capabilityClaims = migrateCapabilityClaims(value.capabilityClaims, approvals, authorities);
  reconcileApprovalClaims(approvals, capabilityClaims, authorities);

  return seedDatabase({
    version: 7,
    agents: value.agents as Database["agents"],
    messages: value.messages as Database["messages"],
    runs: value.runs as Database["runs"],
    approvals,
    auditEvents: migrateAuditEvents(value.auditEvents),
    protectedResources: migrateProtectedResources(value.protectedResources),
    deploymentStates: value.deploymentStates as Database["deploymentStates"],
    actionExecutions: migrateActionExecutions(value.actionExecutions),
    teamMemberships: value.teamMemberships as Database["teamMemberships"],
    agentTeamGrants: value.agentTeamGrants as Database["agentTeamGrants"],
    capabilityClaims,
    registeredDestinations: value.version === 6
      ? migrateRegisteredDestinationsForVersion(value.registeredDestinations as unknown[], true)
      : value.version === 7
        ? migrateRegisteredDestinationsForVersion(value.registeredDestinations as unknown[], false)
      : [],
    destinationReceipts: value.version === 6 || value.version === 7
      ? value.destinationReceipts as Database["destinationReceipts"]
      : [],
    approvalAuthorities: value.version === 7
      ? value.approvalAuthorities as Database["approvalAuthorities"]
      : [],
    teamRuns: Array.isArray(value.teamRuns)
      ? value.teamRuns as Database["teamRuns"]
      : [],
  }, value.version === 5);
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
    const content = JSON.stringify(data, null, 2) + "\n";
    const temporaryPath = this.filePath + ".tmp";
    try {
      await writeFile(temporaryPath, content, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.filePath);
    } catch {
      // Fallback for container volume mounts or file systems where rename has EACCES/EPERM/EBUSY
      await writeFile(this.filePath, content, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
  }
}

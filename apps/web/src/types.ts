export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type HumanId = "user-a" | "user-b";

export interface HumanPrincipal {
  id: HumanId;
  name: string;
}

export interface Agent {
  id: string;
  ownerUserId: "user-a" | "user-b";
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
}

export interface AgentTeamGrant {
  id: string;
  agentId: string;
  teamId: "team-alpha" | "team-beta";
  role: "viewer" | "editor" | "admin";
  allowedActions: ("resource.read" | "file.read" | "deploy.staging" | "deploy.production")[];
  status: "active" | "revoked";
  approvedBy: HumanId;
  expiresAt: string | null;
  bundleVersion: number;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface SystemInfo {
  modelProvider: "ark" | "openai-compatible";
  modelConfigured: boolean;
  modelBaseUrl: string;
  modelName: string | null;
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}

export interface ApprovalRecord {
  id: string;
  humanId: HumanId;
  agentId: string;
  runId: string;
  requestId: string;
  action: "resource.read" | "file.read" | "deploy.staging" | "deploy.production";
  resourceId: string;
  risk: "high";
  reasonCode: string;
  status: "pending" | "approved" | "denied" | "expired" | "consumed" | "revoked";
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
  grantId?: string;
  teamId?: "team-alpha" | "team-beta";
  bundleVersion?: number;
  effectiveScope?: string[];
  humanRole?: "viewer" | "editor" | "admin";
  agentRole?: "viewer" | "editor" | "admin";
  resourceClassification?: "internal" | "sensitive" | "restricted";
  temporaryScope?: string[];
}

export interface AuditEvent {
  id: string;
  eventType: string;
  createdAt: string;
  humanId: HumanId | null;
  agentId: string | null;
  runId: string | null;
  requestId: string | null;
  action: "resource.read" | "file.read" | "deploy.staging" | "deploy.production" | null;
  resourceId: string | null;
  decision: "allow" | "deny" | "require_approval" | null;
  risk: "low" | "medium" | "high" | null;
  reasonCode: string | null;
  approvalId: string | null;
  capabilityId: string | null;
  status: "success" | "failure" | "pending";
  durationMs: number | null;
  policyVersion: string | null;
  explanation: string | null;
  enforcementPoint: string | null;
  protectedActionExecuted: boolean | null;
  grantId: string | null;
  teamId: "team-alpha" | "team-beta" | null;
  bundleVersion: number | null;
  effectiveScope: string[] | null;
  humanRole: "viewer" | "editor" | "admin" | null;
  agentRole: "viewer" | "editor" | "admin" | null;
  resourceClassification: "internal" | "sensitive" | "restricted" | null;
  temporaryScope: string[] | null;
  rejectedFieldNames: string[] | null;
}

export type SecurityLabScenario =
  | "own-project"
  | "cross-user-project"
  | "alpha-internal"
  | "alpha-restricted-jit"
  | "beta-cross-team"
  | "forged-team-admin"
  | "replay-consumed-approval"
  | "revoke-active-run"
  | "revoke-grant"
  | "queued-after-revoke";

export interface SecurityLabResult {
  scenario: SecurityLabScenario;
  scenarioId: string | null;
  humanId: HumanId;
  agentId: string;
  runId: string;
  requestId: string;
  action: string;
  resourceId: string;
  teamId: "team-alpha" | "team-beta" | null;
  status: "success" | "denied" | "approval_required" | "failed" | "conflict";
  decision: "allow" | "deny" | "require_approval";
  initialDecision: "allow" | "deny" | "require_approval" | null;
  operationState: "terminal" | "pending_approval" | "queued";
  revocationPerformed: boolean;
  reasonCode: string;
  approvalId: string | null;
  policyVersion: string;
  enforcementPoint: string;
  protectedActionExecuted: boolean;
  summary: string;
}

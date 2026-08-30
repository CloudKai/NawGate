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
}

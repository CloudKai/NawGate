import type {
  ActionExecutionRecord,
  ApprovalRecord,
  AuditEvent,
  DeploymentState,
  HumanId,
  ApprovalAuthority,
  ProtectedResource,
  AgentTeamGrant,
  TeamMembership,
  RegisteredDestination,
  DestinationSideEffectReceipt,
  AuditChainState,
  TaskNode,
  TaskGraph,
  TeamRun,
  TeamBlackboard,
  TeamArtifact,
  TeamRunStatus,
} from "./nawgate/types.js";

export type {
  TaskNode,
  TaskGraph,
  TeamRun,
  TeamBlackboard,
  TeamArtifact,
  TeamRunStatus,
};

export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

export interface Agent {
  id: string;
  ownerUserId: HumanId;
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
  role: MessageRole;
  content: string;
  createdAt: string;
  authorName?: string;
  teamId?: string | null;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Database {
  version: 8;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  approvals: ApprovalRecord[];
  auditEvents: AuditEvent[];
  protectedResources: ProtectedResource[];
  deploymentStates: DeploymentState[];
  actionExecutions: ActionExecutionRecord[];
  teamMemberships: TeamMembership[];
  agentTeamGrants: AgentTeamGrant[];
  capabilityClaims: import("./nawgate/types.js").CapabilityClaim[];
  registeredDestinations: RegisteredDestination[];
  destinationReceipts: DestinationSideEffectReceipt[];
  approvalAuthorities: ApprovalAuthority[];
  auditChain: AuditChainState;
  teamRuns: TeamRun[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRuntimeEnvironment {
  token: string;
  gatewayUrl: string;
  approvalWaitMs: number;
}

export interface RunnerRequest {
  agentId: string;
  ownerUserId: HumanId;
  runId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  runtime?: RunnerRuntimeEnvironment;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}

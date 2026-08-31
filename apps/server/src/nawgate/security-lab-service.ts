import { randomUUID } from "node:crypto";
import { AgentTeamGrantService } from "./agent-team-grant-service.js";
import { AuditService } from "./audit-service.js";
import { ApprovalService } from "./approval-service.js";
import { RuntimeCredentialService } from "./runtime-credential-service.js";
import { RuntimeGateway } from "./runtime-gateway.js";
import type { NawGateAction, AuditEvent, GatewayResult, HumanPrincipal, TeamId, TrustedRuntimeContext } from "./types.js";
import { NAWGATE_POLICY_VERSION } from "./types.js";

export const SECURITY_LAB_SCENARIOS = ["own-project", "cross-user-project", "alpha-internal", "alpha-restricted-jit", "beta-cross-team", "forged-team-admin", "replay-consumed-approval", "revoke-active-run", "revoke-grant", "queued-after-revoke"] as const;
export type SecurityLabScenario = (typeof SECURITY_LAB_SCENARIOS)[number];
type LabOperationState = "terminal" | "pending_approval" | "queued";

export interface SecurityLabResult {
  scenario: SecurityLabScenario;
  scenarioId: string | null;
  humanId: HumanPrincipal["id"];
  agentId: string;
  runId: string;
  requestId: string;
  action: string;
  resourceId: string;
  teamId: TeamId | null;
  status: "success" | "denied" | "approval_required" | "failed" | "conflict";
  decision: "allow" | "deny" | "require_approval";
  initialDecision: "allow" | "deny" | "require_approval" | null;
  operationState: LabOperationState;
  revocationPerformed: boolean;
  reasonCode: string;
  approvalId: string | null;
  policyVersion: string;
  enforcementPoint: string;
  protectedActionExecuted: boolean;
  summary: string;
}

interface ScenarioRequest { action: NawGateAction; resourceId: string; }
interface PendingJitScenario {
  id: string;
  actor: HumanPrincipal;
  agentId: string;
  context: TrustedRuntimeContext;
  request: ScenarioRequest & { requestId: string };
  approvalId: string;
  timeout: ReturnType<typeof setTimeout>;
}

export class SecurityLabService {
  private readonly pendingJit = new Map<string, PendingJitScenario>();

  constructor(
    private readonly gateway: RuntimeGateway,
    private readonly approvals: ApprovalService,
    private readonly audit: AuditService,
    private readonly credentials: RuntimeCredentialService,
    private readonly grants?: AgentTeamGrantService,
  ) {}

  async run(scenario: SecurityLabScenario, agentId: string, actor: HumanPrincipal): Promise<SecurityLabResult> {
    if (scenario === "alpha-restricted-jit") return this.startJitScenario(agentId, actor);
    if (scenario === "replay-consumed-approval") return this.replayScenario(scenario, agentId, actor);
    if (scenario === "queued-after-revoke") return this.queuedAfterRevoke(agentId, actor);
    if (scenario === "revoke-grant" && this.grants) {
      const grant = this.grants.resolveGrants(agentId).find((item) => item.status === "active" && item.teamId === "team-alpha");
      if (grant) await this.grants.revoke(agentId, grant.id, actor);
    }
    const request = this.requestFor(scenario);
    const runId = randomUUID();
    const requestId = randomUUID();
    const context = { humanId: actor.id, agentId, runId } as const;
    this.credentials.issue(agentId, runId, actor.id);
    await this.recordLabRun("lab_run.started", context, requestId, "security_lab_started", "Security Lab started a scoped demonstration Run.");
    try {
      const revoked = scenario === "revoke-active-run";
      if (revoked) this.credentials.revokeAuthority(runId);
      const result = await this.gateway.execute(context, {
        requestId, ...request,
        ...(scenario === "forged-team-admin" ? { teamId: "team-alpha", role: "admin" } : {}),
      } as never);
      return this.toSafeResult(scenario, actor, agentId, runId, requestId, request, result, {
        initialDecision: revoked ? null : this.decisionFor(result),
        revocationPerformed: revoked || scenario === "revoke-grant",
      });
    } finally {
      await this.cleanupRun(context, "security_lab_terminal", "lab_run.completed");
    }
  }

  async continueJit(scenarioId: string, agentId: string, actor: HumanPrincipal): Promise<SecurityLabResult> {
    const pending = this.requirePendingJit(scenarioId, agentId, actor);
    try {
      const result = await this.gateway.execute(pending.context, {
        requestId: pending.request.requestId,
        action: pending.request.action,
        resourceId: pending.request.resourceId,
        approvalId: pending.approvalId,
      });
      return this.toSafeResult("alpha-restricted-jit", actor, agentId, pending.context.runId, pending.request.requestId, pending.request, result, {
        scenarioId,
        initialDecision: "require_approval",
        operationState: result.status === "approval_required" ? "pending_approval" : "terminal",
      });
    } finally {
      const approval = await this.approvals.get(pending.approvalId);
      if (approval?.status !== "pending") await this.finishPendingJit(pending, "security_lab_jit_terminal");
    }
  }

  async cancelJit(scenarioId: string, agentId: string, actor: HumanPrincipal): Promise<SecurityLabResult> {
    const pending = this.requirePendingJit(scenarioId, agentId, actor);
    await this.finishPendingJit(pending, "security_lab_jit_cancelled", "lab_run.cancelled");
    return this.toSafeResult("alpha-restricted-jit", actor, agentId, pending.context.runId, pending.request.requestId, pending.request, {
      status: "denied", requestId: pending.request.requestId, action: pending.request.action,
      resourceId: pending.request.resourceId, reasonCode: "capability_revoked",
    }, {
      scenarioId, initialDecision: "require_approval", revocationPerformed: true,
      summary: "The pending JIT demonstration was cancelled and its Run authority was revoked.",
    });
  }

  private async startJitScenario(agentId: string, actor: HumanPrincipal): Promise<SecurityLabResult> {
    const request = this.requestFor("alpha-restricted-jit");
    const runId = randomUUID();
    const requestId = randomUUID();
    const context = { humanId: actor.id, agentId, runId } as const;
    this.credentials.issue(agentId, runId, actor.id);
    await this.recordLabRun("lab_run.started", context, requestId, "security_lab_jit_started", "Security Lab started a Run awaiting an exact JIT approval.");
    try {
      const result = await this.gateway.execute(context, { requestId, ...request });
      if (result.status !== "approval_required") {
        await this.cleanupRun(context, "security_lab_jit_unexpected_terminal", "lab_run.completed");
        return this.toSafeResult("alpha-restricted-jit", actor, agentId, runId, requestId, request, result);
      }
      const approval = await this.approvals.get(result.approvalId);
      if (!approval) throw new Error("Expected Security Lab approval");
      const id = randomUUID();
      const timeout = setTimeout(() => {
        const pending = this.pendingJit.get(id);
        if (pending) {
          void this.approvals.get(pending.approvalId).finally(() =>
            this.finishPendingJit(pending, "security_lab_jit_timeout"),
          );
        }
      }, Math.max(1, Date.parse(approval.expiresAt) - Date.now()));
      timeout.unref?.();
      this.pendingJit.set(id, { id, actor, agentId, context, request: { ...request, requestId }, approvalId: result.approvalId, timeout });
      return this.toSafeResult("alpha-restricted-jit", actor, agentId, runId, requestId, request, result, {
        scenarioId: id, initialDecision: "require_approval", operationState: "pending_approval",
        summary: "The owner may approve this exact restricted-file request; the server retries it using the same trusted Run, then closes the demo authority.",
      });
    } catch (error) {
      await this.cleanupRun(context, "security_lab_jit_error", "lab_run.completed");
      throw error;
    }
  }

  private async queuedAfterRevoke(agentId: string, actor: HumanPrincipal): Promise<SecurityLabResult> {
    const scenario: SecurityLabScenario = "queued-after-revoke";
    const request = this.requestFor(scenario);
    const runId = randomUUID();
    const requestId = randomUUID();
    const context = { humanId: actor.id, agentId, runId } as const;
    this.credentials.issue(agentId, runId, actor.id);
    await this.recordLabRun("lab_run.started", context, requestId, "security_lab_queue_started", "Security Lab started a Run paused before final authorization recheck.");
    const barrier = this.gateway.createDemoExecutionBarrier(runId, requestId);
    try {
      const execution = this.gateway.execute(context, { requestId, ...request });
      await barrier.reached;
      this.credentials.revokeAuthority(runId);
      barrier.release();
      const result = await execution;
      return this.toSafeResult(scenario, actor, agentId, runId, requestId, request, result, {
        initialDecision: "allow", operationState: "queued", revocationPerformed: true,
        summary: "The initial allow was queued before the side effect; revocation forced the final RuntimeGateway recheck to deny execution.",
      });
    } finally {
      barrier.dispose();
      await this.cleanupRun(context, "security_lab_queue_terminal", "lab_run.completed");
    }
  }

  private async replayScenario(scenario: SecurityLabScenario, agentId: string, actor: HumanPrincipal): Promise<SecurityLabResult> {
    const request = this.requestFor("alpha-restricted-jit");
    const runId = randomUUID();
    const firstRequestId = randomUUID();
    const context = { humanId: actor.id, agentId, runId } as const;
    this.credentials.issue(agentId, runId, actor.id);
    await this.recordLabRun("lab_run.started", context, firstRequestId, "security_lab_replay_started", "Security Lab started a one-use JIT replay demonstration.");
    try {
      const initial = await this.gateway.execute(context, { requestId: firstRequestId, ...request });
      if (initial.status !== "approval_required") {
        return this.toSafeResult(scenario, actor, agentId, runId, firstRequestId, request, initial, { summary: "Enroll a viewer grant first so this lab can demonstrate one-use JIT replay denial." });
      }
      await this.approvals.approve(initial.approvalId, actor.id);
      await this.gateway.execute(context, { requestId: firstRequestId, ...request, approvalId: initial.approvalId });
      const replayRequestId = randomUUID();
      const replay = await this.gateway.execute(context, { requestId: replayRequestId, ...request, approvalId: initial.approvalId });
      return this.toSafeResult(scenario, actor, agentId, runId, replayRequestId, request, replay, {
        initialDecision: "require_approval",
        summary: "The first approved restricted-file read executed once; replaying the consumed capability was denied and the persistent grant remained unchanged.",
      });
    } finally {
      await this.cleanupRun(context, "security_lab_replay_terminal", "lab_run.completed");
    }
  }

  private requirePendingJit(scenarioId: string, agentId: string, actor: HumanPrincipal): PendingJitScenario {
    const pending = this.pendingJit.get(scenarioId);
    if (!pending || pending.agentId !== agentId || pending.actor.id !== actor.id) throw new Error("Security Lab JIT scenario is no longer active");
    return pending;
  }

  private async finishPendingJit(pending: PendingJitScenario, reasonCode: string, eventType: "lab_run.completed" | "lab_run.cancelled" = "lab_run.completed"): Promise<void> {
    if (!this.pendingJit.delete(pending.id)) return;
    clearTimeout(pending.timeout);
    await this.cleanupRun(pending.context, reasonCode, eventType);
  }

  private async cleanupRun(context: TrustedRuntimeContext, reasonCode: string, eventType: "lab_run.completed" | "lab_run.cancelled"): Promise<void> {
    this.credentials.revokeAuthority(context.runId);
    await this.approvals.revokeForRun(context.runId, reasonCode);
    await this.recordLabRun(eventType, context, null, reasonCode, "Security Lab closed the demo Run and revoked its authority.");
    await this.audit.record({
      eventType: "runtime_identity.revoked", humanId: context.humanId, agentId: context.agentId, runId: context.runId,
      requestId: null, action: null, resourceId: null, decision: "deny", risk: "high", reasonCode,
      approvalId: null, capabilityId: null, status: "success", durationMs: null, policyVersion: NAWGATE_POLICY_VERSION,
      explanation: "Security Lab revoked the synthetic Run authority during terminal cleanup.", enforcementPoint: "SecurityLabService", protectedActionExecuted: false,
    });
  }

  private async recordLabRun(eventType: "lab_run.started" | "lab_run.completed" | "lab_run.cancelled", context: TrustedRuntimeContext, requestId: string | null, reasonCode: string, explanation: string): Promise<void> {
    await this.audit.record({
      eventType, humanId: context.humanId, agentId: context.agentId, runId: context.runId, requestId,
      action: null, resourceId: null, decision: null, risk: null, reasonCode, approvalId: null, capabilityId: null,
      status: "success", durationMs: null, policyVersion: NAWGATE_POLICY_VERSION, explanation,
      enforcementPoint: "SecurityLabService", protectedActionExecuted: false,
    });
  }

  private requestFor(scenario: SecurityLabScenario): ScenarioRequest {
    switch (scenario) {
      case "own-project": return { action: "resource.read", resourceId: "project-a" };
      case "cross-user-project": return { action: "resource.read", resourceId: "project-b" };
      case "alpha-internal": return { action: "file.read", resourceId: "team-alpha-internal" };
      case "alpha-restricted-jit": case "replay-consumed-approval": return { action: "file.read", resourceId: "team-alpha-restricted" };
      case "beta-cross-team": return { action: "file.read", resourceId: "team-beta-internal" };
      case "queued-after-revoke": return { action: "resource.read", resourceId: "project-a" };
      case "forged-team-admin": case "revoke-grant": case "revoke-active-run": return { action: "file.read", resourceId: "team-alpha-internal" };
    }
  }

  private toSafeResult(scenario: SecurityLabScenario, actor: HumanPrincipal, agentId: string, runId: string, requestId: string, request: ScenarioRequest, result: GatewayResult, options: Partial<Pick<SecurityLabResult, "scenarioId" | "initialDecision" | "operationState" | "revocationPerformed" | "summary">> = {}): SecurityLabResult {
    const event = this.latestEvent(agentId, runId, requestId);
    const status = result.status;
    return {
      scenario, scenarioId: options.scenarioId ?? null, humanId: actor.id, agentId, runId, requestId,
      action: request.action, resourceId: request.resourceId, teamId: event?.teamId ?? null, status,
      decision: this.decisionFor(result), initialDecision: options.initialDecision ?? null,
      operationState: options.operationState ?? "terminal", revocationPerformed: options.revocationPerformed ?? false,
      reasonCode: event?.reasonCode ?? (status === "success" ? "protected_action_succeeded" : result.reasonCode),
      approvalId: result.status === "approval_required" ? result.approvalId : null,
      policyVersion: event?.policyVersion ?? NAWGATE_POLICY_VERSION, enforcementPoint: event?.enforcementPoint ?? "RuntimeGateway",
      protectedActionExecuted: event?.protectedActionExecuted === true, summary: options.summary ?? this.defaultSummary(status),
    };
  }

  private decisionFor(result: GatewayResult): SecurityLabResult["decision"] {
    return result.status === "success" ? "allow" : result.status === "approval_required" ? "require_approval" : "deny";
  }

  private latestEvent(agentId: string, runId: string, requestId: string): AuditEvent | null {
    return [...this.audit.list(agentId)].reverse().find((event) =>
      event.runId === runId &&
      event.requestId === requestId &&
      (event.eventType.startsWith("policy.") || event.eventType.startsWith("protected_action.")),
    ) ?? null;
  }

  private defaultSummary(status: SecurityLabResult["status"]): string {
    if (status === "success") return "Protected action executed through RuntimeGateway.";
    if (status === "approval_required") return "No protected side effect executed; owner approval is pending.";
    if (status === "conflict") return "The request conflicted with an existing idempotent operation.";
    if (status === "failed") return "Authorization completed, but the protected action failed during execution.";
    return "RuntimeGateway denied the protected action before execution.";
  }
}

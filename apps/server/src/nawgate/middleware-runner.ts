import type { AppConfig } from "../config.js";
import { RunCancelledError } from "../errors.js";
import { AuditService } from "./audit-service.js";
import { ApprovalService } from "./approval-service.js";
import { RuntimeCredentialService } from "./runtime-credential-service.js";
import type {
  AgentRunner,
  RunnerRequest,
  RunnerResult,
} from "../types.js";

const RUNTIME_CREDENTIAL_REDACTION = "[REDACTED_RUNTIME_CREDENTIAL]";

function redactRuntimeCredential(value: string, token: string): string {
  return value.includes(token) ? value.split(token).join(RUNTIME_CREDENTIAL_REDACTION) : value;
}

export class MiddlewareRunner implements AgentRunner {
  constructor(
    private readonly inner: AgentRunner,
    private readonly credentials: RuntimeCredentialService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    private readonly approvals?: ApprovalService,
  ) {}

  async run(request: RunnerRequest): Promise<RunnerResult> {
    const startedAt = Date.now();
    const credential = this.credentials.issue(
      request.agentId,
      request.runId,
      request.ownerUserId,
    );
    try {
      await this.audit.record({
        eventType: "runtime_identity.issued",
        humanId: request.ownerUserId,
        agentId: request.agentId,
        runId: request.runId,
        requestId: null,
        action: null,
        resourceId: null,
        decision: null,
        risk: null,
        reasonCode: "run_started",
        approvalId: null,
        capabilityId: null,
        status: "success",
        durationMs: 0,
        explanation: "A short-lived Run identity was issued; the raw credential is never audited.",
        enforcementPoint: "MiddlewareRunner",
        protectedActionExecuted: false,
      });
      await this.audit.record({
        eventType: "run.started",
        humanId: request.ownerUserId,
        agentId: request.agentId,
        runId: request.runId,
        requestId: null,
        action: null,
        resourceId: null,
        decision: null,
        risk: null,
        reasonCode: null,
        approvalId: null,
        capabilityId: null,
        status: "success",
        durationMs: 0,
      });
      const result = await this.inner.run({
        ...request,
        // Protected resources are kept out of the application filesystem.
        // Only the disposable container Runtime receives the protected-action
        // credential; local-process remains a starter-compatible normal Run.
        ...(this.config.runtimeProvider === "container"
          ? {
              runtime: {
                token: credential.token,
                gatewayUrl: this.config.nawGateGatewayUrl,
                approvalWaitMs: this.config.nawGateApprovalWaitMs,
              },
            }
          : {}),
      });
      await this.audit.record({
        eventType: "run.completed",
        humanId: request.ownerUserId,
        agentId: request.agentId,
        runId: request.runId,
        requestId: null,
        action: null,
        resourceId: null,
        decision: null,
        risk: null,
        reasonCode: null,
        approvalId: null,
        capabilityId: null,
        status: "success",
        durationMs: Date.now() - startedAt,
      });
      return {
        ...result,
        output: redactRuntimeCredential(result.output, credential.token),
        threadId: result.threadId
          ? redactRuntimeCredential(result.threadId, credential.token)
          : null,
      };
    } catch (error) {
      await this.audit.record({
        eventType: error instanceof RunCancelledError ? "run.cancelled" : "run.failed",
        humanId: request.ownerUserId,
        agentId: request.agentId,
        runId: request.runId,
        requestId: null,
        action: null,
        resourceId: null,
        decision: null,
        risk: null,
        reasonCode: error instanceof Error ? error.name : "run_failed",
        approvalId: null,
        capabilityId: null,
        status: "failure",
        durationMs: Date.now() - startedAt,
      });
      if (error instanceof RunCancelledError) throw error;
      if (error instanceof Error) {
        const safe = redactRuntimeCredential(error.message, credential.token);
        if (safe !== error.message) throw new Error(safe, { cause: error });
      }
      throw error;
    } finally {
      this.credentials.revoke(request.runId);
      await this.approvals?.revokeForRun(request.runId, "run_finished");
      await this.audit.record({
        eventType: "runtime_identity.revoked",
        humanId: request.ownerUserId,
        agentId: request.agentId,
        runId: request.runId,
        requestId: null,
        action: null,
        resourceId: null,
        decision: "deny",
        risk: null,
        reasonCode: "run_finished",
        approvalId: null,
        capabilityId: null,
        status: "success",
        durationMs: Date.now() - startedAt,
        explanation: "The short-lived Run identity was revoked during lifecycle cleanup.",
        enforcementPoint: "MiddlewareRunner",
        protectedActionExecuted: false,
      });
    }
  }

  cancel(agentId: string): Promise<boolean> {
    return this.inner.cancel(agentId);
  }

  isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }
}

import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { ApprovalError, ApprovalService } from "./agentgate/approval-service.js";
import { AuditService } from "./agentgate/audit-service.js";
import { IdentityService } from "./agentgate/identity-service.js";
import { RuntimeCredentialService } from "./agentgate/runtime-credential-service.js";
import { RuntimeGateway } from "./agentgate/runtime-gateway.js";
import { AGENTGATE_POLICY_VERSION, type GatewayResult, type TrustedRuntimeContext } from "./agentgate/types.js";
import type { AgentService } from "./agent-service.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
}).strict();
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});
const demoSessionBody = z.object({
  userId: z.enum(["user-a", "user-b"]),
}).strict();
const runtimeActionBody = z.object({
  requestId: z.string().uuid(),
  action: z.enum(["resource.read", "file.read", "deploy.staging", "deploy.production"]),
  resourceId: z.string().min(1).max(120),
  approvalId: z.string().uuid().optional(),
}).strict();
const runtimeApprovalParams = z.object({ id: z.string().uuid() });
const approvalQuery = z.object({
  status: z.enum(["pending", "approved", "denied", "expired", "consumed", "revoked"]).optional(),
}).strict();
const auditQuery = z.object({
  runId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
}).strict();

const RUNTIME_POLL_AFTER_MS = 1_000;

export interface RuntimeApiDependencies {
  credentials: RuntimeCredentialService;
  gateway: RuntimeGateway;
  approvals: ApprovalService;
  audit: AuditService;
}

function runtimeContext(
  request: { headers: Record<string, string | string[] | undefined> },
  runtime: RuntimeApiDependencies,
): TrustedRuntimeContext | null {
  const header = request.headers["x-agentgate-runtime"];
  const token = typeof header === "string" ? header : undefined;
  const resolved = runtime.credentials.resolve(token);
  if (resolved.status === "valid") return resolved.context;
  throw new HttpError(
    401,
    resolved.status === "expired"
      ? "Runtime credential expired"
      : "Invalid runtime credential",
    resolved.status === "expired"
      ? "RUNTIME_CREDENTIAL_EXPIRED"
      : "INVALID_RUNTIME_CREDENTIAL",
  );
}

function publicGatewayCode(reasonCode: string): string {
  if (
    reasonCode === "approval_denied" ||
    reasonCode === "capability_consumed" ||
    reasonCode === "capability_revoked"
  ) {
    return "APPROVAL_DENIED";
  }
  if (reasonCode === "approval_expired") return "APPROVAL_EXPIRED";
  return "ACTION_NOT_PERMITTED";
}

function sendRuntimeResult(reply: {
  code: (statusCode: number) => { send: (payload: unknown) => unknown };
  send: (payload: unknown) => unknown;
}, result: GatewayResult): unknown {
  if (result.status === "success") {
    return reply.code(200).send({
      status: "success",
      requestId: result.requestId,
      action: result.action,
      resourceId: result.resourceId,
      result: {
        summary: result.result.summary,
        ...(result.result.content !== undefined ? { content: result.result.content } : {}),
      },
    });
  }
  if (result.status === "approval_required") {
    return reply.code(202).send({
      status: "approval_required",
      requestId: result.requestId,
      approvalId: result.approvalId,
      pollAfterMs: RUNTIME_POLL_AFTER_MS,
    });
  }
  if (result.status === "denied") {
    return reply.code(403).send({
      status: "denied",
      requestId: result.requestId,
      action: result.action,
      resourceId: result.resourceId,
      code: publicGatewayCode(result.reasonCode),
      reasonCode: result.reasonCode,
      message:
        result.reasonCode === "approval_denied"
          ? "The owner did not approve this protected action."
          : result.reasonCode === "capability_revoked"
            ? "The owner revoked this Run's protected-action authority."
          : "This Agent is not permitted to perform that protected action.",
    });
  }
  if (result.status === "conflict") {
    return reply.code(409).send({
      status: "conflict",
      requestId: result.requestId,
      code: "IDEMPOTENCY_MISMATCH",
    });
  }
  return reply.code(500).send({
    status: "failed",
    requestId: result.requestId,
    code: "PROTECTED_ACTION_FAILED",
  });
}

function throwApprovalHttpError(error: unknown): never {
  if (!(error instanceof ApprovalError)) throw error;
  const statusCode =
    error.code === "APPROVAL_NOT_FOUND"
      ? 404
      : error.code === "APPROVAL_EXPIRED"
        ? 410
      : error.code === "APPROVAL_NOT_OWNED"
          ? 403
          : error.code === "APPROVAL_REVOKED"
            ? 409
          : 409;
  throw new HttpError(statusCode, "Approval request cannot be changed", error.code);
}

export async function createApp(
  config: AppConfig,
  service: AgentService,
  identity: IdentityService = new IdentityService(),
  runtime?: RuntimeApiDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.x-agentgate-session",
        "req.headers.x-agentgate-runtime",
      ],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth" ||
      request.url === "/api/runtime" ||
      request.url.startsWith("/api/runtime/")
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  const humanActor = (request: { headers: Record<string, string | string[] | undefined> }) =>
    identity.requireSession(
      typeof request.headers["x-agentgate-session"] === "string"
        ? request.headers["x-agentgate-session"]
        : undefined,
    );

  app.get("/api/demo/users", async () => ({ users: identity.listUsers() }));

  app.post("/api/demo/session", async (request) => {
    const body = demoSessionBody.parse(request.body);
    return identity.createSession(body.userId);
  });

  app.get("/api/demo/me", async (request) => ({ user: humanActor(request) }));

  if (runtime) {
    app.get("/api/agents/:id/approvals", async (request) => {
      const { id } = agentIdParams.parse(request.params);
      const query = approvalQuery.parse(request.query);
      const actor = humanActor(request);
      service.getAgent(id, actor);
      return { approvals: await runtime.approvals.list(actor.id, query.status, id) };
    });

    app.get("/api/agents/:id/audit", async (request) => {
      const { id } = agentIdParams.parse(request.params);
      const query = auditQuery.parse(request.query);
      const actor = humanActor(request);
      service.getAgent(id, actor);
      const events = runtime.audit.list(id, query.runId);
      return { audit: events.slice(Math.max(0, events.length - query.limit)) };
    });

    app.post("/api/agents/:id/revoke-access", async (request) => {
      const { id } = agentIdParams.parse(request.params);
      const actor = humanActor(request);
      const activeRun = service.getActiveRun(id, actor);
      if (!activeRun) {
        throw new HttpError(409, "No active Run to revoke");
      }
      runtime.credentials.revokeAuthority(activeRun.id);
      const revokedApprovals = await runtime.approvals.revokeForRun(activeRun.id);
      await runtime.audit.record({
        eventType: "runtime_identity.revoked",
        humanId: actor.id,
        agentId: id,
        runId: activeRun.id,
        requestId: null,
        action: null,
        resourceId: null,
        decision: "deny",
        risk: "high",
        reasonCode: "owner_revoked",
        approvalId: null,
        capabilityId: null,
        status: "success",
        durationMs: null,
        policyVersion: AGENTGATE_POLICY_VERSION,
        explanation: "The owner revoked the active Run authority; future protected requests fail closed.",
        enforcementPoint: "RuntimeGateway",
        protectedActionExecuted: false,
      });
      return {
        runId: activeRun.id,
        status: "revoked" as const,
        approvalsRevoked: revokedApprovals.length,
      };
    });

    app.post("/api/approvals/:id/approve", async (request) => {
      const { id } = runtimeApprovalParams.parse(request.params);
      const actor = humanActor(request);
      try {
        const result = await runtime.approvals.approve(id, actor.id);
        return { approval: result.approval };
      } catch (error) {
        return throwApprovalHttpError(error);
      }
    });

    app.post("/api/approvals/:id/deny", async (request) => {
      const { id } = runtimeApprovalParams.parse(request.params);
      const actor = humanActor(request);
      try {
        return { approval: await runtime.approvals.deny(id, actor.id) };
      } catch (error) {
        return throwApprovalHttpError(error);
      }
    });

    app.post("/api/runtime/actions", async (request, reply) => {
      const body = runtimeActionBody.parse(request.body);
      const context = runtimeContext(request, runtime);
      if (!context) return;
      const result = await runtime.gateway.execute(context, {
        requestId: body.requestId,
        action: body.action,
        resourceId: body.resourceId,
        ...(body.approvalId ? { approvalId: body.approvalId } : {}),
      });
      return sendRuntimeResult(reply, result);
    });

    app.get("/api/runtime/approvals/:id", async (request, reply) => {
      const { id } = runtimeApprovalParams.parse(request.params);
      const context = runtimeContext(request, runtime);
      if (!context) return;
      const approval = await runtime.approvals.get(id);
      if (
        !approval ||
        approval.humanId !== context.humanId ||
        approval.agentId !== context.agentId ||
        approval.runId !== context.runId
      ) {
        return reply.code(404).send({
          status: "denied",
          code: "APPROVAL_DENIED",
        });
      }
      if (approval.status === "pending") {
        return reply.code(200).send({
          status: "pending",
          approvalId: approval.id,
          pollAfterMs: RUNTIME_POLL_AFTER_MS,
        });
      }
      if (approval.status === "expired") {
        return reply.code(200).send({ status: "expired", code: "APPROVAL_EXPIRED" });
      }
      if (approval.status === "denied") {
        return reply.code(200).send({ status: "denied", code: "APPROVAL_DENIED" });
      }
      if (approval.status === "consumed") {
        return reply.code(200).send({ status: "denied", code: "APPROVAL_DENIED" });
      }
      if (approval.status === "revoked") {
        return reply.code(200).send({ status: "denied", code: "APPROVAL_DENIED" });
      }
      const capabilityStatus = runtime.approvals.capabilityStatus(approval.id);
      if (capabilityStatus === "expired") {
        return reply.code(200).send({ status: "expired", code: "APPROVAL_EXPIRED" });
      }
      if (capabilityStatus !== "usable") {
        return reply.code(200).send({ status: "denied", code: "APPROVAL_DENIED" });
      }
      return reply.code(200).send({ status: "approved", approvalId: approval.id });
    });
  }

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async (request) => ({ agents: service.listAgents(humanActor(request)) }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body, humanActor(request));
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id, humanActor(request)) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body, humanActor(request)) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id, humanActor(request));
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id, humanActor(request)) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id, humanActor(request)) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(id, humanActor(request)) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id, humanActor(request)) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content, humanActor(request));
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id, humanActor(request)) };
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    const runtimeAuthError =
      error instanceof HttpError &&
      (error.code === "INVALID_RUNTIME_CREDENTIAL" ||
        error.code === "RUNTIME_CREDENTIAL_EXPIRED");
    return reply.code(statusCode).send({
      ...(runtimeAuthError ? { status: "unauthorized" } : {}),
      error: appError.message,
      ...(error instanceof HttpError && error.code ? { code: error.code } : {}),
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}

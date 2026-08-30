# Audit and Observability Contract

## Goal

Every protected decision must be explainable without leaking secrets or payloads.

Audit supports the Bouncer story. Audit itself never grants permission.

## Event types

```ts
type AuditEventType =
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "policy.allow"
  | "policy.deny"
  | "policy.approval_required"
  | "approval.approved"
  | "approval.denied"
  | "approval.expired"
  | "capability.issued"
  | "capability.consumed"
  | "protected_action.succeeded"
  | "protected_action.failed";
```

## Schema

```ts
type AuditEvent = {
  id: string;
  createdAt: string;
  eventType: AuditEventType;

  humanId: string | null;
  agentId: string | null;
  runId: string | null;
  requestId: string | null;

  action: AgentGateAction | null;
  resourceId: string | null;

  decision: "allow" | "deny" | "require_approval" | null;
  risk: "low" | "medium" | "high" | null;
  reasonCode: string | null;

  approvalId: string | null;
  capabilityId: string | null;

  status: "success" | "failure" | "pending";
  durationMs: number | null;
};
```

## Mandatory correlation

For a protected action, operator can answer:

- human?
- Agent?
- Run?
- request?
- action?
- resource?
- decision?
- reason?
- approval?
- execution result?

## Never audit

- Ark key;
- APP_AUTH_TOKEN;
- demo session token;
- runtime token;
- full environment;
- authorization headers;
- cookie header;
- protected resource body;
- user-entered secret;
- unsanitized arbitrary stdout/stderr.

## Fastify redaction

Existing baseline redacts:

```text
req.headers.authorization
req.headers.cookie
```

Add:

```text
req.headers.x-agentgate-session
req.headers.x-agentgate-runtime
```

Verify exact Fastify/Pino redaction path.

## Reason codes

Use stable:

```text
resource_owner_mismatch
production_deploy_requires_owner_approval
runtime_credential_expired
capability_consumed
```

Do not encode protected content in reason string.

## Causal examples

Approved deploy:

```text
policy.approval_required
approval.approved
capability.issued
capability.consumed
protected_action.succeeded
```

Cross-user denial:

```text
policy.deny
```

No later action success for that request.

## Run middleware

MiddlewareRunner may record:

```text
run.started
run.completed / failed / cancelled
```

with duration and available token usage.

Do not duplicate full user prompt into AgentGate audit.

Existing messages already store conversation.

## Optional Codex event enrichment

Only after MVP:

- capture exact `codex exec --json` output from pinned version;
- add fixtures/tests;
- parse verified command/file event types.

Do not assume newest SDK event schema.

## OpenTelemetry stretch mapping

Potential attributes:

```text
agentgate.human.id
agentgate.agent.id
agentgate.run.id
agentgate.action
agentgate.resource.id
agentgate.policy.outcome
agentgate.policy.reason
agentgate.approval.id
```

Never attach token or protected body.

OTel is export, not authorization source.

## UI timeline

Example:

```text
19:42:10 ALLOW     resource.read      project-a
19:42:18 DENY      resource.read      project-b
19:42:32 APPROVAL  deploy.production  production
19:42:39 APPROVED  user-a
19:42:40 SUCCESS   deploy.production  production
```

## Tests

- runtime sentinel token absent from audit JSON;
- human session sentinel absent;
- protected body absent from deny event;
- protected decision has human/Agent/Run;
- approval events share approval/run;
- hard-denied request never has protected-action success.

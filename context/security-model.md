# Security Model and Threat Model

## Objective

A protected side effect occurs only after the backend:

1. authenticates the exact Agent Run;
2. derives human owner;
3. evaluates deterministic policy;
4. satisfies any required owner approval;
5. executes through protected resource service;
6. records redacted evidence.

## Assets

- per-user protected demo data;
- simulated staging/production state;
- Agent ownership;
- approval/capability state;
- audit integrity;
- runtime credentials;
- APP_AUTH_TOKEN;
- Ark API key.

Use synthetic demo content only.

## Principals

### HumanPrincipal

`user-a`, `user-b`.

Server-resolved from opaque demo session.

### AgentPrincipal

CodeJam Agent ID + server-owned `ownerUserId`.

### Run context

Exact CodeJam Run ID.

### Runtime credential

Proof of one provisioned Agent/Run context.

It proves identity, not authorization.

## Trust assumptions

Trusted POC:

- Fastify process;
- AgentGate services;
- JsonStore/data directory;
- protected-resource service.

Untrusted/partially trusted:

- browser;
- prompts;
- Codex output;
- runtime process/container;
- external content;
- identity fields in request bodies.

Treat Agent runtime as capable of attempting misuse.

## Threats and controls

### T1 Cross-user protected data

A-owned Agent requests B-owned resource.

Control:

- resource owner server-side;
- runtime resolves human A;
- policy owner mismatch => hard deny;
- approval cannot override.

### T2 Agent forges identity

Body includes fake `agentId`/`ownerUserId`.

Control:

- ignore/reject;
- derive from runtime credential.

### T3 Browser chooses Agent owner

Control:

- create route derives owner from human session;
- request schema excludes owner.

### T4 High-risk action auto-runs

Control:

- deterministic `require_approval`;
- resource service not called;
- owner-only approval;
- one-use capability.

### T5 Approval replay

Control:

- exact Agent/Run/action/resource/request binding;
- short TTL;
- one use;
- consumed.

### T6 Approval target substitution

Control:

- exact equality on lease fields;
- changed target => no match/new approval.

### T7 Runtime credential replay

Control:

- short expiry;
- revoke on Run end;
- exact Run metadata;
- credential cannot call human approval API.

### T8 Token leakage

Control:

- Fastify redaction;
- no token in audit;
- no env dump;
- sentinel tests.

### T9 Prompt injection

Control:

- authorization is downstream deterministic code;
- prompt cannot rewrite policy.

### T10 Direct protected-file access

Control:

- protected resources outside workspace mounts.

### T11 Duplicate deployment on retry

Control:

- client requestId;
- `runId + requestId` idempotency;
- terminal result replay without second side effect.

### T12 Unknown action falls through

Control:

- closed action union/Zod enum;
- default deny.

### T13 Wrong human approves

Control:

- human session resolved backend;
- must match approval owner.

### T14 Direct resource-service bypass

Control:

- no public route directly invokes protected service;
- gateway is only exposed path.

### T15 Audit becomes exfiltration

Control:

- metadata only;
- no protected body/token.

## OWASP Excessive Agency mapping

| Risk | AgentGate control |
|---|---|
| excessive tool functionality | narrow registered commands |
| excessive permissions | per-owner resource policy |
| excessive autonomy | approval for production |
| generic privileged downstream identity | per-Run owner context |
| open-ended tools | typed actions |
| lack of complete mediation | server gateway |
| missing evidence | audit timeline |

## Security invariants to test

1. authenticated runtime identity != automatically authorized action.
2. client identity fields never become truth.
3. hard deny before approval lookup.
4. approval cannot override hard deny.
5. missing/expired credential never falls back.
6. unknown action never executes.
7. unknown/cross-user resource never returns protected body.
8. raw runtime token not durable.
9. capability one-use + TTL.
10. protected side effect idempotent.
11. owner-only approval.
12. audit contains no secrets/payload.
13. restart removes temporary authority.
14. starter cancellation still works.

## Explicit non-goals

Not solved:

- host compromise;
- kernel/container escape;
- hardened multi-tenancy;
- arbitrary Codex command interception;
- full egress control;
- Ark compromise;
- real account takeover;
- identity federation;
- secrets vault.

Do not overclaim.

## Failure philosophy

Security failure:

- stable code;
- no protected side effect;
- generic Agent-facing message;
- owner-visible reason code;
- no stack/secret exposure.

Unexpected internal error:

- fail closed;
- safe audit/log;
- never reinterpret as allow.

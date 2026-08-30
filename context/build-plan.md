# Build Plan — AgentGate

## Principle

Every phase leaves repository runnable/testable.

Backend security before UI.

No stretch infrastructure before end-to-end Bouncer demo works.

# Phase 0 — Baseline Freeze

- inspect actual branch/commit;
- install dependencies;
- run typecheck/test/build/check;
- start local POC if credentials available;
- create Agent + harmless task;
- record baseline deviations.

Acceptance: know baseline state before edits.

# Phase 1 — Data Schema, Human Identity, Agent Ownership

## 1. AgentGate types

Add typed human, approval, audit, resource/policy models.

## 2. Database v2 migration

Extend Database with:

- approvals;
- audit;
- protected resources;
- deployment state;
- action executions.

Explicit v1 -> v2 migration.

Seed safe project-a/project-b fixtures.

Preserve Agents/messages/Runs.

Legacy POC owner: user-a unless repository has a better explicit migration policy.

## 3. IdentityService

Fixed User A/User B registry.

Opaque random server-memory session with expiry.

## 4. Demo identity API

- GET users;
- POST session;
- GET me.

Redact header.

## 5. Ownership

Agent owner backend-derived on create.

Enforce in AgentService and routes.

Tests:

- A owns A Agent;
- B cannot get/update/delete/start/stop/send;
- list only owned;
- create body cannot set owner.

Acceptance: `npm run check`, backend cross-user Agent access denied.

# Phase 2 — Policy + Protected Resource Boundary

## 1. ProtectedResourceService

Server-only:

- read fixture;
- simulated deploy.

No direct public route.

## 2. PolicyEngine

Implement exact policy-contract rules.

Full unit matrix.

## 3. RuntimeGateway server-only

Use trusted context in tests before runtime auth exists.

Flow:

resource -> policy -> allow/deny/approval-needed -> resource.

Tests:

- A project-a allow;
- A project-b deny;
- deny proves zero execution;
- unknown action deny;
- staging allow;
- production returns approval-needed/no deployment.

Acceptance: backend policy proven without Codex.

# Phase 3 — Audit, Approval, Capability, Idempotency

## AuditService

Persist structured redacted events.

## ApprovalService

- pending approval;
- owner-only approve/deny;
- expiry;
- exact one-use capability in memory;
- consumption.

Inject clock.

## RuntimeGateway integration

Critical ordering:

```text
trusted context
-> resource
-> hard policy
-> deny?
-> approval required?
-> valid exact lease?
-> execute
-> idempotency
-> audit
```

Hard deny precedes approval.

## Idempotency

`runId + requestId`.

Same terminal request returns prior result.

Changed action/resource same ID -> conflict.

Acceptance: full allow/deny/approve/replay server-only tests pass.

# Phase 4 — Run Identity + MiddlewareRunner

## RuntimeCredentialService

- 256-bit opaque token;
- SHA-256 hash in memory;
- Agent/Run/owner/expiry metadata;
- revoke.

Tests valid/random/expired/revoked.

## RunnerRequest

Add exact `runId`, `ownerUserId` correlation.

## MiddlewareRunner

- issue credential;
- inject trusted runtime context;
- audit run.started;
- delegate;
- audit terminal;
- revoke in finally.

FakeRunner tests.

## RunnerFactory

Wrap selected existing runner.

## Base runner env

Only AgentGate-specific allowlisted env.

Update existing runner tests.

Acceptance: normal CodeJam Run succeeds through decorator.

# Phase 5 — Runtime API + `agentctl`

## Runtime auth boundary

`/api/runtime/*` skips APP_AUTH_TOKEN and requires runtime credential.

## POST actions

Exact runtime protocol.

## Approval polling route

Run-scoped.

## agentctl

Commands:

- resource read;
- deploy staging;
- deploy production.

Bounded polling, stable errors, no token output.

## Runtime installation

Make CLI available in judged local container.

Test actual command.

## Workspace instructions

Teach Agent to use `agentctl`.

Acceptance: CLI success, deny, approval-wait.

# Phase 6 — Human Approval API + UI

## Human endpoints

- list approvals;
- approve;
- deny;
- audit.

Owner-only.

## Frontend API

Add demo session header and methods.

Session token module-memory only.

## UI

- DemoActorSwitch;
- AgentGatePanel;
- ApprovalCard;
- AuditTimeline.

## Live approval

Approval UI works while Run is busy and CLI is polling.

Acceptance: human approves within same active Run.

# Phase 7 — End-to-End

1. harmless normal coding task;
2. project-a allow;
3. project-b deny;
4. production pending;
5. prove no deployment before approval;
6. owner approve once;
7. same Run resumes/completes;
8. capability consumed;
9. later new deploy requires new approval;
10. complete audit chain.

# Phase 8 — Hardening / Submission

- security bypass review;
- secret scan;
- regression;
- README;
- limitations;
- update Archify design if needed;
- `npm run check`;
- rehearse 3-minute demo.

# Stretch S1 — OPA

Only after MVP.

Replace policy implementation behind interface.

Failure cannot silently allow.

# Stretch S2 — OpenTelemetry

Export existing events.

No secrets.

# Stretch S3 — MCP

Expose same protected actions through MCP.

Same RuntimeGateway.

# Stretch S4 — richer authorization

Possible:

- RBAC/ABAC;
- per-Agent scopes;
- rate/budget;
- network allowlists.

Not before core judged behavior is stable.

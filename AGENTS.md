# AGENTS.md — AgentGate Implementation Contract

Every coding agent working in this repository MUST follow this file.

## Mission

Build **AgentGate**, a backend-enforced delegated-access middleware for the existing CloudKai/CodeJam Agent Launchpad.

Primary TechJam story: **Bouncer — identity and authorization**.

Supporting capabilities: human approval, one-use capability delegation, and audit evidence.

Do not turn this into several unrelated middleware tracks.

## Source-of-truth order

1. actual repository code and tests;
2. this `AGENTS.md`;
3. `context/security-model.md` and `context/policy-contract.md`;
4. `context/architecture.md` and `context/runtime-protocol.md`;
5. `context/api-contract.md`;
6. `context/build-plan.md`;
7. remaining context files;
8. general model knowledge.

## Required first action in each fresh session

Before editing, inspect:

- `package.json`
- `apps/server/src/types.ts`
- `apps/server/src/agent-service.ts`
- `apps/server/src/app.ts`
- `apps/server/src/runner-factory.ts`
- both Codex runners
- `apps/server/src/store.ts`
- `apps/server/src/workspace.ts`
- `apps/web/src/api.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/styles.css`
- `context/progress-tracker.md`

Do not begin by installing packages or rewriting architecture.

## Non-negotiable invariants

### Backend enforcement

Never rely on:

- prompt instructions;
- the LLM deciding whether an action is safe;
- UI visibility;
- client-supplied `userId`, `ownerUserId`, `agentId`, or `runId`.

Trusted identity is derived by the backend.

### Separate decision and enforcement

`PolicyEngine` decides.

`RuntimeGateway` enforces.

Policy must not execute side effects.

### Fail closed

Unknown action, resource, identity, approval state, capability state, or malformed input => deny.

### Approval cannot override hard deny

Approval may satisfy only `require_approval`.

It MUST NOT override:

- cross-user access;
- unknown action;
- invalid runtime identity;
- expired runtime identity;
- malformed request.

### Protected resources stay outside Agent workspace

If the Agent can directly mount/read a protected file, the policy is not meaningful.

### Short-lived Run identity

Every Run receives scoped temporary runtime identity.

Revoke it on Run completion, failure, or cancellation.

Never log or persist the raw runtime credential.

### Preserve the starter

Do not break:

- Agent CRUD;
- start/stop;
- Playground;
- workspace persistence;
- thread resume;
- container/local-process runners;
- Ark configuration;
- existing tests.

## MVP implementation policy

Prefer:

- TypeScript;
- existing Fastify;
- existing Zod;
- existing Vitest;
- existing JsonStore;
- Node built-ins.

Do NOT add OPA, SPIRE, OpenTelemetry Collector, Temporal, Redis, Postgres, Kubernetes, or a new framework before the MVP passes.

## Recommended module boundaries

```text
apps/server/src/agentgate/
  types.ts
  demo-users.ts
  identity-service.ts
  runtime-credential-service.ts
  policy-engine.ts
  approval-service.ts
  audit-service.ts
  protected-resource-service.ts
  runtime-gateway.ts
  middleware-runner.ts
  agentctl-source.ts
  index.ts
```

Frontend additions should be isolated approximately under:

```text
apps/web/src/components/agentgate/
  DemoActorSwitch.tsx
  AgentGatePanel.tsx
  ApprovalCard.tsx
  AuditTimeline.tsx
```

## Security coding rules

- Never print environment variables.
- Never log AgentGate runtime/session headers.
- Never put real secrets in tests.
- Never audit protected resource contents.
- Never use an LLM for authorization/risk/approval/redaction.
- Never let the Agent self-approve.
- Never call workspace instructions a security control.
- Never expose another user's protected payload.

## Work discipline

Implement exactly one phase from `context/build-plan.md` at a time.

For each phase:

1. inspect actual relevant code;
2. implement the smallest complete slice;
3. add positive and negative tests;
4. run narrow tests;
5. run `npm run check`;
6. update `context/progress-tracker.md`;
7. stop if phase acceptance criteria fail.

## Definition of done

MVP is not done until:

- User A/User B exist as demo human principals;
- Agents have backend-owned ownership;
- User B cannot access User A's Agent;
- Agent A can read User A's protected resource;
- Agent A cannot read User B's protected resource;
- high-risk production action creates human approval;
- only owner can approve;
- approval creates exact short-lived one-use capability;
- action succeeds once;
- replay/expiry is denied;
- every decision produces redacted audit evidence;
- starter behavior still works;
- `npm run check` passes;
- 3-minute demo is reproducible.

## Scope boundary

AgentGate protects **registered protected actions** routed through its gateway.

It does not claim to intercept every internal Codex shell command/file operation. The current CodeJam `AgentRunner` wraps a whole Run, not every internal tool call.

Never make a false security claim.

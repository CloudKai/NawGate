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
3. tracked `docs/agentgate/overview.md`, `docs/agentgate/architecture.md`,
   `docs/agentgate/decisions.md`, and `docs/agentgate/demo.md`;
4. remaining tracked documentation;
5. local `context/` and `design/` files, when present, as non-authoritative
   planning artifacts;
6. general model knowledge.

The local `context/` and `design/` directories are intentionally gitignored.
Do not make a fresh clone depend on them; update the tracked public docs when
the implementation changes.

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

### Explicit revocation

An owner can revoke an active Run's runtime authority. Revocation invalidates
the current credential, blocks a queued credential from being minted, and
invalidates pending or approved one-use capabilities. The revocation decision
must be audited with a safe explanation. This is authority revocation, not a
claim that every internal Codex shell operation is forcibly terminated.

### Policy evidence

Meaningful policy decisions carry the central AgentGate policy version,
explanation, enforcement point, and whether a protected side effect executed.
The Web UI may display a safe Delegation Receipt, but never a secret or
protected payload.

### JIT elevation and Security Lab

`bouncer-v4` allows an exact, one-use JIT capability only after the persistent
Agent grant and all hard prerequisites have passed. JIT MUST NOT mutate an
`AgentTeamGrant` role, action scope, status, or bundle version. Temporary
authority is exact-resource scoped, exact-action scoped, Run-bound, expiring,
revocable, and one-use.

Approval MUST NOT repair cross-team access, missing membership, missing or
revoked/expired grant, forged trusted attributes, unknown resource, or any
other hard deny. The final pre-side-effect recheck is mandatory even after a
capability is consumed.

Security Lab scenarios use the real backend enforcement path and may be
enabled only through explicit local/demo configuration. They never expose a
raw Runtime credential. Every terminal demo path must revoke its synthetic Run
authority and pending/approved capabilities. Any demo synchronization hook is
server-only and exists solely to prove the real final recheck. Safe audit for a
malformed Runtime body may use only the already-resolved trusted context and
bounded field names; never audit attacker-controlled values.

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
  DelegationReceipt.tsx
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
- owner revocation invalidates active Run authority and capabilities;
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

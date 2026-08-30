# Code Standards — AgentGate

## Engineering mindset

Operate as a senior security-conscious TypeScript engineer.

- inspect before changing;
- preserve starter structure;
- small composable services;
- security property = test;
- deterministic over clever;
- fail closed;
- negative tests mandatory;
- avoid distributed infrastructure until local POC works.

## TypeScript

- strict mode;
- no `any`;
- narrow `unknown`;
- explicit public service return types;
- discriminated unions for policy results;
- `const` by default;
- closed literal unions for actions/status;
- no generic untyped security payloads.

## Responsibilities

### IdentityService

Only:

- issue/resolve demo human session;
- expiry.

No policy/resource execution.

### RuntimeCredentialService

Only:

- issue;
- resolve;
- expire;
- revoke Run credential.

No policy.

### PolicyEngine

Only typed input -> typed decision.

No side effects.

### ApprovalService

Only:

- pending approval;
- owner decision;
- capability lease;
- expiry/consumption.

### RuntimeGateway

Coordinates:

- runtime authentication;
- resource lookup;
- policy;
- approval;
- idempotency;
- resource execution;
- audit.

### ProtectedResourceService

Performs protected action only when called by gateway.

No independent auth rules.

### AuditService

Metadata evidence only.

## No LLM security decisions

Never use Codex/Ark/LLM to:

- allow/deny;
- determine owner;
- verify credential;
- decide approval requirement;
- consume capability;
- redact a secret.

## Errors

Use stable safe public errors.

Unexpected logs may include:

- safe correlation IDs;
- class/reason;
- no token/payload.

## Async

- await state mutations;
- bounded polling;
- no unhandled floating promises;
- cleanup in `finally`;
- credential revoke in `finally`;
- no unbounded retry.

## Time

Expiry services should accept injectable clock where useful.

No tests that wait minutes.

## Randomness

Use Node crypto:

```ts
randomBytes
randomUUID
createHash
```

Never `Math.random()` for tokens.

## Runtime token design

Recommended:

```ts
const raw = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(raw).digest("base64url");
```

Store hash + metadata only.

## Validation

Use Zod at HTTP boundary before side effects.

Use strict schema for runtime action.

## JsonStore

Preserve serialized `mutate`.

Add explicit migration.

Never mutate snapshot then forget persist.

## Ownership

Do not accept owner from create payload.

Service methods should receive trusted actor/context.

Ownership enforcement below route/UI.

## Run identity

Pass exact `runId` to runner.

Do not infer by "latest run".

## Policy centralization

Do not scatter action allow/deny if-statements throughout routes/UI.

Use one policy implementation.

## Approval concurrency

Two simultaneous approve calls must not create two valid usable leases.

Use serialized mutation/service locking.

## Capability safety

- exact binding;
- one use;
- expiry;
- cannot override hard deny.

## Idempotency

Protected side effects keyed by Run + requestId.

Do not execute twice on retry.

## Frontend

- UI never grants permission itself;
- no token in localStorage/sessionStorage;
- module-memory human session token;
- human-readable safe errors;
- no runtime token exposure.

## CSS

Reuse starter CSS.

No Tailwind/framework rewrite.

## Tests

Every security capability:

1. positive;
2. negative;
3. bypass/replay when relevant.

Examples:

- owner allow/wrong owner deny;
- forged body identity no bypass;
- approval exact target;
- other owner approval deny;
- expired/used capability deny;
- duplicate request one execution.

## Comments

Comment why the trust boundary exists.

Example:

```ts
// Runtime identity comes from credential lookup; never trust agentId from body.
```

## Dependencies

MVP target zero new runtime dependencies.

Do not install package for UUID/hash/fetch/Zod/testing already available.

## Git/phase discipline

Do not mix AgentGate phase with:

- dependency upgrades;
- whole-repo formatting;
- unrelated refactor;
- UI redesign.

## Security questions per phase

- what is untrusted?
- where is identity derived?
- where is permission decided?
- where does side effect occur?
- bypass route?
- unknown-state behavior?
- possible secret log?
- negative test?

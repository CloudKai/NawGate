# Testing and Demo Plan

## Philosophy

Security claim must have executable evidence.

Every critical path: positive + negative + bypass/replay where relevant.

## Baseline regression

Preserve existing tests and:

```bash
npm run test
npm run check
```

Protect:

- lifecycle;
- conversation persistence;
- one active Run;
- cancellation;
- runner args;
- outer auth.

## Unit tests

### IdentityService

- valid session;
- invalid token;
- expired;
- token unpredictable.

### RuntimeCredentialService

- valid exact metadata;
- random fails;
- expired fails;
- revoked fails;
- no raw token persisted.

### PolicyEngine

Full policy matrix.

### ApprovalService

- owner approve;
- non-owner denied;
- human deny;
- expiry;
- exact action/resource/Run match;
- wrong target fails;
- one-use;
- consumed fails.

### AuditService

- correlation fields;
- no token;
- no protected body;
- Agent/Run filtering.

### ProtectedResourceService

- fixture read;
- deployment state;
- execution counter.

## RuntimeGateway

### Allow

A / project-a / read:

- allow;
- resource executes once;
- audit success.

### Cross-user

A / project-b:

- deny;
- resource execution count = 0;
- approval not used;
- audit deny.

### Production

Before approval:

- approval required;
- deployment count 0.

After owner approval:

- capability valid;
- deploy count 1;
- consumed.

### Used capability

Separate new operation requires approval again.

### Idempotent retry

Same terminal request:

- same result;
- deploy count still 1.

### Mismatch

Same requestId changed target -> 409/no execute.

## AgentService ownership

User B cannot:

- get;
- update;
- delete;
- start;
- stop;
- message;
- read messages;
- read Runs

of User A's Agent.

List only owned.

## Fastify boundary

Use `app.inject`.

Test:

- missing outer token when configured;
- outer token but no human session;
- valid own session;
- cross-user route denial;
- no runtime token;
- APP_AUTH_TOKEN alone cannot call runtime;
- valid runtime token;
- expired runtime token;
- forged body identity no bypass;
- owner-only approval.

## Secret tests

Use sentinel:

```text
TEST_RUNTIME_SECRET_DO_NOT_LOG
TEST_HUMAN_SESSION_DO_NOT_LOG
```

Assert absent from audit/API/captured logs if feasible.

Never use real Ark key.

## Manual POC

### A baseline

Prompt:

```text
Create hello.txt containing "hello" and confirm it exists.
```

Normal Run completes.

### B own read

```text
Use AgentGate to read my protected project profile project-a.
```

Expected:

- agentctl;
- ALLOW;
- allowed synthetic data;
- audit.

### C cross-user denial

```text
Use AgentGate to read protected project profile project-b.
```

Expected:

- backend DENY;
- no project-b data;
- audit deny.

### D production approval

```text
Use AgentGate to deploy this project to production.
```

Expected:

- approval card while Run active;
- deployment unchanged.

Click Approve once.

Expected:

- same waiting CLI sees approval;
- deploy executes;
- capability consumed;
- audit chain.

### E one-use proof

New production request -> new approval.

## Three-minute demo

### 0:00-0:25 problem

Explain shared starter token is not human/Agent authorization.

Show User A owns Agent A.

### 0:25-0:50 starter preserved

Normal workspace task.

### 0:50-1:15 allow

project-a -> ALLOW.

Show human, Agent, Run, action, resource.

### 1:15-1:40 deny

project-b -> DENY.

Show no protected disclosure.

### 1:40-2:25 approval

production -> approval required.

Show state unchanged.

Click Approve once.

Show completion.

### 2:25-2:55 audit

Timeline:

```text
ALLOW project-a
DENY project-b
APPROVAL_REQUIRED production
APPROVED user-a
CAPABILITY_CONSUMED
SUCCESS production
```

### 2:55 close

Explain PDP/PEP separation, per-Run identity, temporary authority, hard deny cannot be approved away.

## Deterministic fallback

If Ark/model does not choose agentctl reliably, use a deterministic script from the same runtime container that invokes the real CLI/backend.

Do not fake UI state.

## Final checklist

- [ ] unknown action denies
- [ ] cross-user deny before approval
- [ ] body cannot forge identity
- [ ] browser cannot assign owner
- [ ] non-owner cannot approve
- [ ] lease exact
- [ ] lease expires
- [ ] one use
- [ ] duplicate request no duplicate side effect
- [ ] runtime credential revoked in finally
- [ ] protected data outside workspace
- [ ] secret headers redacted
- [ ] audit no token/body
- [ ] existing tests pass
- [ ] no false "all Codex commands intercepted" claim

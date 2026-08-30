# Professional / Industry Rationale

## PEP/PDP separation

Policy systems such as Open Policy Agent distinguish enforcement from decision.

AgentGate:

```text
RuntimeGateway = PEP
PolicyEngine   = PDP
```

Benefits:

- policy unit-testable;
- side effects isolated;
- future OPA adapter;
- clearer trust boundary;
- better audit.

## Workload identity

Professional systems avoid one shared identity for all autonomous work.

AgentGate models:

```text
Human User A
  owns
Agent A
  starts
Run 123
  gets
short-lived runtime identity
```

This is inspired by workload-identity systems such as SPIFFE/SPIRE, without claiming compliance.

## Least privilege

Agent does not receive generic admin tool.

Protected tools are narrow:

```text
resource.read
deploy.staging
deploy.production
```

## Complete mediation

Protected resource is outside workspace and reachable only through gateway.

Stronger than prompt-only "do not read User B".

## Human-in-the-loop

Low-risk owned reads auto-allow.

Production requires explicit owner approval.

This balances autonomy and consent.

## Just-in-time authority

Approval does not create a permanent role.

Capability is:

- exact;
- short-lived;
- Run-bound;
- one-use.

## Revocable Run identity

Credential expires/revokes after Run.

No permanent Agent API key.

## Auditability

Evidence chain:

```text
human
agent
run
request
action
resource
policy
approval
execution
```

## Idempotency

Real APIs assume retries.

`requestId` prevents double side effect.

## Fail closed

Unknown/invalid state => deny.

Especially important for autonomous Agents because unexpected behavior is normal.

## Why not install every industry product

Professional architecture is not measured by logos.

For local single-process 72-hour POC:

- in-process policy is more reliable;
- structured audit is enough;
- POC workload credential proves identity model.

Interfaces preserve upgrade path to OPA/OTel/SPIFFE/MCP.

## Honest boundary

Claim:

> AgentGate controls registered protected operations.

Do NOT claim:

> AgentGate intercepts every possible Codex command.

That honesty makes the design stronger.

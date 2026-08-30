# AgentGate Bouncer

AgentGate is the selected TechJam middleware track: backend-enforced identity
and authorization for registered protected actions.

The control plane owns the human-to-Agent relationship. Each Run receives a
short-lived runtime identity containing the backend-owned human, Agent, and Run
binding. `agentctl` sends registered actions to `RuntimeGateway`, which loads
protected-resource metadata, evaluates `PolicyEngine`, and is the only path
that can execute a protected side effect.

## Behavior

- User A's Agent can read `project-a`.
- User A's Agent cannot read `project-b`, even if an approval identifier is
  supplied.
- Production deploy is high risk and pauses for owner approval.
- Approval mints an exact, one-use, short-lived capability.
- Replays with a new request ID, expired approvals, invalid capabilities, and
  revoked Run authority fail closed without executing the protected action.
- Every decision is redacted audit evidence. Policy decisions carry the
  central version `bouncer-v2`, a reason explanation, and `RuntimeGateway` as
  the enforcement point.
- Protected team files use backend-resolved membership relationships and role
  thresholds. Internal files may be shared with team viewers, while restricted
  files require an elevated team role and non-members fail closed.

The Delegation Receipt in the Web UI is a safe summary of the human, Agent,
Run, action, resource, risk, reason, policy version, timestamps, expiry, uses,
and status. It never displays a runtime credential, API key, or protected
resource payload.

## Scope

AgentGate protects registered actions routed through `agentctl`. It does not
intercept every internal Codex shell command or file operation inside a Run.
The disposable Runtime container is the demo boundary; this is not a claim of
hardened multi-tenant isolation.

The standards lineage and deliberate production limits are documented in
[`standards.md`](standards.md). Team-file authorization is a focused extension
of the Bouncer story, not a claim that the POC is a complete enterprise IAM
system.

## Verification

```bash
npm run check
npm run test:container # optional; requires a built local Runtime image
```

The deterministic end-to-end test always runs as part of `npm run test`.
The real-container test is explicitly gated so ordinary CI does not need a
local Docker or Podman daemon.

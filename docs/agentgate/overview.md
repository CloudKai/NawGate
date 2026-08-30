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
  central version `bouncer-v4`, a reason explanation, and `RuntimeGateway` as
  the enforcement point.
- Protected team files require the intersection of the current human team
  relationship, a persistent administrator-approved Agent grant, the Run
  identity, and the resource role threshold. A viewer grant may request a
  restricted-file read only through a one-use, exact-bound owner-approved JIT
  capability; the persistent grant remains viewer. The grant survives across
  Runs, but never replaces the short-lived per-Run identity.
- Team-grant revocation invalidates active Run authority and pending or
  approved capabilities. The gateway re-resolves mutable authority immediately
  before a protected side effect, so a queued stale allow cannot execute.

The Delegation Receipt in the Web UI is a safe summary of the human, Agent,
team membership role, persistent grant role/bundle, Run, temporary JIT scope,
action, resource, risk, reason, policy version, enforcement point, timestamps,
expiry, uses, and status. It never displays a runtime credential, API key, or
protected resource payload.

When enabled for the local POC, the Security Lab in the side panel runs
redacted scenarios through the real RuntimeGateway: own/cross-user resources,
team files, a complete JIT approval/retry/cleanup lifecycle, capability replay,
forged attributes, Run revocation, grant revocation, and a deterministic queued
initial-allow → revoke → final-recheck denial. Opaque scenario references keep
the Runtime credential server-side. It is disabled by default outside the local
demo configuration.

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

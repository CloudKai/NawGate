# NawGate Bouncer

NawGate is the selected TechJam middleware track: backend-enforced identity
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
- Medium/high actions pause for one owner approval; critical actions pause for
  two distinct approvals.
- Approval mints an exact, one-use, short-lived capability claim. The claim is
  durably stored without a bearer secret, so a service restart reconstructs
  its safe state and concurrent consumers still get one atomic use.
- Approval and idempotency bindings include the trusted human, Agent, Run,
  request, action, resource, canonical payload digest, optional destination,
  grant bundle, policy revision, and protected-resource revision. A payload,
  destination, grant, policy, or resource revision substitution fails closed.
- Replays with a new request ID, expired approvals, invalid capabilities, and
  revoked Run authority fail closed without executing the protected action.
- Every decision is redacted audit evidence. Policy decisions carry the
  central version `bouncer-v5`, deterministic risk version `risk-v1`, a safe
  risk-facts digest, explanation, and `RuntimeGateway` as the enforcement point.
- Risk is assigned by a pure backend risk engine from trusted action, resource
  classification, destination audience/reach/environment, asset type, region,
  and resource/destination revisions. Runtime payloads cannot lower the tier.
  The sensitive `asset-user-a-video-2` publish/export path is critical and
  requires User A's owner authority plus the distinct Org A reviewer authority
  held by User C. User B is not eligible for that Org A reviewer slot.
- Protected team files require the intersection of the current human team
  relationship, a persistent administrator-approved Agent grant, the Run
  identity, and the resource role threshold. A viewer grant may request a
  restricted-file read only through a one-use, exact-bound owner-approved JIT
  capability; the persistent grant remains viewer. The grant survives across
  Runs, but never replaces the short-lived per-Run identity.
- Team-grant revocation invalidates active Run authority and pending or
  approved capabilities. The gateway re-resolves mutable authority immediately
  before a protected side effect, so a queued stale allow cannot execute.
- Synthetic TikTok-oriented content actions use a registered organisation →
  business centre → account → asset hierarchy. `content.moderate` is a
  processing-only action that returns an aggregate result without raw content;
  `content.disclose` requires an exact backend-approved account/asset scope.
  `content.publish` and `content.export` require owner approval and preserve
  exact asset, destination, purpose, content-version, payload, and one-use
  capability bindings.
- Content purposes are a closed set: `safety_moderation`,
  `creator_requested_publish`, `approved_analytics`, and
  `compliance_archive`. Missing, unknown, mismatched, cross-business,
  cross-asset, cross-user, and unregistered-destination inputs fail closed.
- Non-moderation content actions use the server-owned registered destination
  catalogue. Its stable IDs are `tiktok-account:brand-sg`,
  `tiktok-account:creator-demo`, `analytics:approved-dashboard`, and
  `archive:compliance-store`; each record binds the owning organisation,
  business centre, account, allowed action/purpose, local HTTPS method/host/path
  pattern, classification, enabled/disabled/revoked status, revision, and a credential
  reference. Requests carry only the destination ID. The persisted catalogue
  is authoritative; there is no arbitrary URL or static fallback path.
- The server-side credential broker injects only synthetic credentials into the
  trusted local fake adapter. The adapter performs a serialized final
  destination/resource revision check before credential injection and writes a
  safe side-effect receipt containing metadata and the credential reference,
  never the credential or protected content. Destination revision changes and
  revocation invalidate pending/approved claims. This local adapter makes no
  external call and does not claim network isolation.
- Legacy approval/action records without the new exact binding are migrated to
  safe terminal/non-replayable state; unbound claims are not restored.

The Delegation Receipt in the Web UI is a safe summary of the human, Agent,
team membership role, persistent grant role/bundle, Run, temporary JIT scope,
action, resource, risk tier/version, approval count/roles, safe approver
identifiers, reason, policy version, enforcement point, timestamps, expiry,
uses, and status. It never displays a runtime credential, API key, payload, or
protected resource content.

When enabled for the local POC, the Security Lab in the side panel runs
redacted scenarios through the real RuntimeGateway: own/cross-user resources,
team files, a complete JIT approval/retry/cleanup lifecycle, capability replay,
forged attributes, Run revocation, grant revocation, and a deterministic queued
initial-allow → revoke → final-recheck denial. Opaque scenario references keep
the Runtime credential server-side. It is disabled by default outside the local
demo configuration.

## Scope

NawGate protects registered actions routed through `agentctl`. It does not
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

# Registered protected-action sequence

This sequence covers only registered actions sent through `agentctl` and
`RuntimeGateway`. It does not claim to intercept arbitrary Codex shell,
filesystem, or network operations.

Explore the [interactive sequence](https://cloudkai.github.io/NawGate/docs/nawgate/sequence.html).
For broader boundaries, see the [architecture overview](architecture.md).

## GitHub fallback

```mermaid
sequenceDiagram
  actor Human as Human authority
  participant UI as React UI
  participant API as Fastify control plane
  participant Runtime as Codex Runtime / agentctl
  participant Gateway as RuntimeGateway
  participant Policy as Policy + approval services
  participant Store as JsonStore + audit
  participant Target as Protected action

  Human->>UI: Start Agent/Team Run
  UI->>API: Authenticated Run request
  API->>Store: Resolve Agent owner and create Run
  API-->>Runtime: Scoped short-lived Runtime credential
  Runtime->>Gateway: HTTP registered action via agentctl
  Gateway->>Store: Resolve Human, Agent, Run and verify credential
  Gateway->>Store: Verify audit chain and idempotency
  Gateway->>Policy: Resolve resource/team/grant/destination facts
  Policy-->>Gateway: bouncer-v5 + risk-v1 outcome
  alt DENY
    Gateway->>Store: Append redacted terminal evidence
    Gateway-->>Runtime: Safe denial
  else ALLOW
    Gateway->>Store: Final transactional authority recheck
    Gateway->>Target: Execute registered side effect
    Target-->>Gateway: Safe execution receipt
    Gateway->>Store: Persist receipt and audit evidence
    Gateway-->>Runtime: Safe result
  else REQUIRE_APPROVAL
    Gateway->>Store: Create exact pending claim
    Gateway-->>Runtime: Pending; agentctl polls for bounded time
    Human->>UI: Owner approval
    UI->>API: Approve exact claim
    opt Critical risk
      Human->>UI: Independent reviewer approval
      UI->>API: Approve as distinct reviewer
    end
    API->>Store: Issue expiring one-use capability
    Runtime->>Gateway: Retry exact request
    Gateway->>Store: Consume capability (1 to 0)
    Gateway->>Store: Final transactional recheck
    alt Authority changed or revoked
      Gateway->>Store: Audit revocation-race denial
      Gateway-->>Runtime: DENY without side effect
    else Authority still valid
      Gateway->>Target: Execute once
      Target-->>Gateway: Safe receipt
      Gateway->>Store: Persist receipt and audit evidence
      Gateway-->>Runtime: Safe result
    end
  end
  Runtime->>Gateway: Replay same capability/request
  Gateway-->>Runtime: Stored safe idempotent result or replay denial; never re-execute
  API->>Store: Run terminal cleanup revokes credential and claims
```

## Security properties

- The backend issues Runtime authority only after resolving the authenticated
  human and backend-owned Agent. The raw credential is not logged, audited, or
  returned to the browser.
- `RuntimeGateway` derives Human, Agent, and Run identity from the credential;
  it rejects missing, malformed, expired, or revoked authority.
- Audit-chain verification and idempotency conflict checks happen before a
  protected side effect. A damaged audit chain places protected writes in
  quarantine instead of silently repairing history.
- Resource, team membership, persistent Agent grant, destination, purpose,
  revision, and risk facts come from server-owned state. `bouncer-v5` and
  `risk-v1` are deterministic; the model never authorizes a request.
- `ALLOW`, `DENY`, and `REQUIRE_APPROVAL` are distinct outcomes. Approval can
  satisfy only an eligible approval requirement and cannot override a hard
  deny.
- Medium/high actions require an eligible owner. Critical actions require two
  distinct eligible humans with owner and independent-reviewer roles.
- A finalized capability is bound to the exact human, Agent, Run, request,
  action, resource, canonical payload, destination, revisions, policy/risk
  evidence, and approval decisions. It expires, is revocable, and has one use.
- Consumption and the final pre-side-effect recheck are transactional. A Run,
  grant, resource, destination, capability, or approval revoked while queued
  yields a terminal denial with no side effect.
- Execution returns only a safe receipt/result. Same-request retries are
  idempotent; substitution conflicts and capability replay cannot execute the
  action again.
- Completion, failure, cancellation, or owner revocation removes Runtime
  authority and invalidates pending or approved claims.

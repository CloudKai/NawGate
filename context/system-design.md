# System Design Walkthrough

## Main path

```mermaid
flowchart LR
    H[Human User] --> UI[React UI]
    UI --> API[Fastify Control Plane]
    API --> ID[Human Identity + Agent Ownership]
    ID --> S[AgentService]
    S --> RF[RunnerFactory]
    RF --> MR[MiddlewareRunner]
    MR --> CR[ContainerCodexRunner / CodexRunner]
    CR --> C[Codex CLI]
    C --> ARK[Volcengine Ark]

    MR -. short-lived Run identity .-> C
    C --> TOOL[agentctl]
    TOOL --> GW[RuntimeGateway / PEP]
    GW --> P[PolicyEngine / PDP]
    GW --> A[Approval + Capability]
    GW --> R[ProtectedResourceService]
    GW --> AU[AuditService]
```

## Allowed own-resource sequence

```mermaid
sequenceDiagram
    participant U as User A
    participant C as Codex Agent A
    participant T as agentctl
    participant G as AgentGate
    participant P as Policy
    participant R as Protected Resource
    participant A as Audit

    U->>C: Read project-a
    C->>T: resource read project-a
    T->>G: runtime credential + typed action
    G->>G: derive user-a / Agent A / Run
    G->>P: owner/action/resource
    P-->>G: ALLOW
    G->>R: read project-a
    R-->>G: allowed content
    G->>A: policy.allow + success
    G-->>T: 200
    T-->>C: result
```

## Cross-user denial

```mermaid
sequenceDiagram
    participant U as User A
    participant C as Codex Agent A
    participant T as agentctl
    participant G as AgentGate
    participant P as Policy
    participant R as Project B
    participant A as Audit

    U->>C: Read project-b
    C->>T: resource read project-b
    T->>G: runtime credential + typed action
    G->>P: user-a vs owner user-b
    P-->>G: DENY
    Note over G,R: Protected service is not executed
    G->>A: policy.deny
    G-->>T: 403
```

## Human approval

```mermaid
sequenceDiagram
    participant U as User A
    participant C as Codex Agent A
    participant T as agentctl
    participant G as AgentGate
    participant P as Policy
    participant AP as ApprovalService
    participant R as Production
    participant A as Audit

    U->>C: Deploy production
    C->>T: deploy production
    T->>G: action request
    G->>P: evaluate
    P-->>G: REQUIRE_APPROVAL
    G->>AP: create pending approval
    G-->>T: 202
    loop bounded poll
        T->>G: approval status
        G-->>T: pending
    end
    U->>G: Approve once via UI
    G->>AP: owner check + one-use lease
    T->>G: retry same request
    G->>P: re-evaluate hard policy
    P-->>G: REQUIRE_APPROVAL
    G->>AP: consume exact lease
    AP-->>G: valid
    G->>R: deploy once
    G->>A: approval + capability + success
    G-->>T: 200
```

## Important detail

On retry after approval, re-evaluate hard policy before consuming lease.

Do not skip from "approved" straight to side effect.

If owner/resource state changed, stale approval must not bypass policy.

## Archify

`design/agentgate-codejam.architecture.json` and `design/agentgate-codejam.workflow.json` are Archify-native typed sources for presentation-quality diagrams.

Mermaid here is for implementation readability.

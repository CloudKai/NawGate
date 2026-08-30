# Policy Contract

## Principle

Policy is deterministic.

It MUST NOT call Ark, OpenAI, or any LLM.

## Action registry

```ts
type AgentGateAction =
  | "resource.read"
  | "deploy.staging"
  | "deploy.production";
```

Unknown action => deny.

## Normalized resource

```ts
type PolicyResource = {
  id: string;
  type: "project_profile" | "deployment_target";
  ownerUserId: string;
  classification: "internal" | "sensitive";
};
```

Never put protected body into policy input if metadata is enough.

## Policy input

```ts
type PolicyInput = {
  humanId: string;
  agentId: string;
  runId: string;
  requestId: string;
  action: AgentGateAction;
  resource: PolicyResource;
  environment: "local" | "staging" | "production";
};
```

Identity fields come from trusted backend context.

## Decision

```ts
type PolicyDecision =
  | {
      outcome: "allow";
      risk: "low" | "medium";
      reasonCode: "owned_resource_read" | "owned_staging_deploy";
    }
  | {
      outcome: "deny";
      risk: "low" | "medium" | "high";
      reasonCode:
        | "resource_owner_mismatch"
        | "unknown_action"
        | "unknown_resource"
        | "invalid_context";
    }
  | {
      outcome: "require_approval";
      risk: "high";
      reasonCode: "production_deploy_requires_owner_approval";
    };
```

## Ordered rules

### Rule 0 Invalid context

```text
DENY invalid_context
```

### Rule 1 Ownership mismatch

If:

```text
humanId != resource.ownerUserId
```

then:

```text
DENY resource_owner_mismatch
```

Hard deny. Stop. Do not inspect approval.

### Rule 2 resource.read

Owned:

```text
ALLOW low owned_resource_read
```

### Rule 3 deploy.staging

Owned:

```text
ALLOW medium owned_staging_deploy
```

### Rule 4 deploy.production

Owned:

```text
REQUIRE_APPROVAL high production_deploy_requires_owner_approval
```

### Rule 5 Default

```text
DENY unknown_action
```

## Capability lease

Created only after `require_approval` + owner approval.

```ts
type CapabilityLease = {
  id: string;
  approvalId: string;
  humanId: string;
  agentId: string;
  runId: string;
  action: AgentGateAction;
  resourceId: string;
  requestId: string;
  issuedAt: string;
  expiresAt: string;
  remainingUses: 1 | 0;
};
```

Valid only when every field matches exact request.

Recommended TTL: 5 minutes.

Consume before protected execution.

If execution fails after consumption, require a new approval unless idempotency proves no effect occurred.

## Approval record

```ts
type ApprovalRecord = {
  id: string;
  humanId: string;
  agentId: string;
  runId: string;
  requestId: string;
  action: AgentGateAction;
  resourceId: string;
  risk: "high";
  reasonCode: string;
  status: "pending" | "approved" | "denied" | "expired" | "consumed";
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
};
```

Only bound human may approve/deny.

Approval cannot edit target/action/Run/Agent.

## Timing

Suggested:

- agentctl wait: 90 seconds;
- pending approval expiry: 5 minutes;
- capability TTL: 5 minutes.

Use injectable clock in tests.

## Policy matrix

| Human | Action | Resource owner | Decision |
|---|---|---|---|
| A | read | A | allow |
| A | read | B | deny |
| A | staging | A | allow |
| A | production | A | require approval |
| A | production | B | deny |
| B | read | B | allow |
| B | read | A | deny |
| A | unknown | A | deny |

Test malformed/unknown resources too.

## Future OPA

Preserve:

```ts
interface PolicyEngine {
  evaluate(input: PolicyInput): Promise<PolicyDecision>;
}
```

An OPA adapter can replace the implementation later.

RuntimeGateway remains the PEP.

OPA failure must never silently allow.

# UI Rules — Minimal AgentGate Evidence Surface

## Core rule

Middleware behavior matters more than UI breadth.

Preserve the existing CodeJam UI.

## Required UI

### DemoActorSwitch

Shows current actor:

```text
Acting as: User A
```

Switch User A/User B.

On switch:

1. request new demo session;
2. clear selected Agent;
3. refresh owned Agents;
4. clear old approval/audit state.

Never carry User A selected Agent into User B state.

### AgentGatePanel

For selected Agent:

- owner;
- pending approvals;
- latest audit.

### ApprovalCard

Immutable display:

- Agent;
- Run short ID;
- action;
- resource;
- high risk;
- reason;
- created time.

Buttons:

- Approve once;
- Deny.

No editable target/action.

### AuditTimeline

Show latest events:

- time;
- status;
- action;
- resource;
- reason.

## Busy Run behavior

Current UI already polls Run status.

While Run is active:

- continue Run polling;
- refresh pending approvals/audit;
- approval buttons remain interactive;
- composer may remain disabled as existing behavior.

This is necessary for same-Run approval while `agentctl` waits.

## Errors

Good:

```text
This protected action was denied by AgentGate.
Only the Agent owner can approve this action.
This approval expired; ask the Agent to try again.
```

Bad:

```text
HttpError at runtime-gateway.ts:...
```

## Enforcement rule

React never changes durable approval state itself.

Click -> backend endpoint -> owner validation -> capability.

UI hidden state is not auth.

## Empty states

Approvals:

```text
No approvals waiting.
High-risk protected actions will appear here.
```

Audit:

```text
No AgentGate decisions yet.
Run a protected action to generate evidence.
```

## Demo clarity

Judge should instantly see:

- who is acting;
- which Agent/Run;
- what action;
- allow/deny/approval;
- whether capability was one-use.

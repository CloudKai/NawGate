# UI Registry

Update after each AgentGate component is built.

## Existing patterns to preserve

| Pattern | Location |
|---|---|
| app shell/sidebar | `apps/web/src/App.tsx` |
| Agent cards | `App.tsx` + `styles.css` |
| status pill | `App.tsx` |
| buttons | `styles.css` |
| error banner | `App.tsx` |
| Playground | `App.tsx` |
| Run polling | `App.tsx` |
| API helper | `apps/web/src/api.ts` |

## New components

### DemoActorSwitch

Suggested:

`apps/web/src/components/agentgate/DemoActorSwitch.tsx`

Status: [x] built
Actual path: `apps/web/src/components/agentgate/DemoActorSwitch.tsx`
Props: `actor`, `disabled`, `onSwitch`
CSS: `.actor-switch`

### AgentGatePanel

Suggested:

`apps/web/src/components/agentgate/AgentGatePanel.tsx`

Status: [x] built
Actual path: `apps/web/src/components/agentgate/AgentGatePanel.tsx`
Props: `agent`, `approvals`, `audit`, `busyApprovalId`, `onApprove`, `onDeny`
CSS: `.agentgate-panel`, `.agentgate-grid`, `.agentgate-section-title`

### ApprovalCard

Suggested:

`apps/web/src/components/agentgate/ApprovalCard.tsx`

Status: [x] built
Actual path: `apps/web/src/components/agentgate/ApprovalCard.tsx`
Props: `approval`, `busy`, `onApprove`, `onDeny`
CSS: `.approval-card`, `.approval-details`, `.approval-actions`

### AuditTimeline

Suggested:

`apps/web/src/components/agentgate/AuditTimeline.tsx`

Status: [x] built
Actual path: `apps/web/src/components/agentgate/AuditTimeline.tsx`
Props: `events`
CSS: `.audit-timeline`, `.audit-event`, `.audit-event-dot`

## Update rule

After implementation record:

- actual path;
- props;
- CSS classes;
- status;
- deviations.

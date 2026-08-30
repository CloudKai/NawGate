# Runtime Protocol — `agentctl` and RuntimeGateway

## Purpose

`agentctl` is the explicit protected-tool boundary for CodeJam Agents.

It exists because current `AgentRunner` wraps a whole Codex Run rather than providing a pre-command callback for every internal action.

AgentGate guarantees mediation for **registered protected operations** routed through `agentctl`.

## Runtime environment

Each active Run receives:

```text
AGENTGATE_RUNTIME_TOKEN
AGENTGATE_GATEWAY_URL
AGENTGATE_APPROVAL_WAIT_MS
```

The raw token:

- is random;
- is scoped to one Run/Agent/owner;
- expires;
- is revoked after Run;
- is never printed.

## Runtime authentication header

```http
X-AgentGate-Runtime: <runtime token>
```

Do not give the runtime `APP_AUTH_TOKEN`.

Runtime identity and human/browser perimeter auth are separate.

## Action endpoint

```text
POST /api/runtime/actions
```

Read request:

```json
{
  "requestId": "uuid",
  "action": "resource.read",
  "resourceId": "project-a"
}
```

Deploy request:

```json
{
  "requestId": "uuid",
  "action": "deploy.production",
  "resourceId": "production"
}
```

Do not include trusted identity fields.

If caller sends `humanId`, `ownerUserId`, `agentId`, or `runId`, reject strict schemas or ignore them. Never trust them.

## Gateway order

1. parse/validate body;
2. authenticate runtime token;
3. derive human/Agent/Run;
4. enforce expiry/revocation;
5. normalize action/resource;
6. load protected resource metadata;
7. check idempotency;
8. evaluate hard policy;
9. deny immediately if hard deny;
10. resolve/create approval if required;
11. verify/consume exact capability if approved;
12. execute protected resource;
13. persist terminal idempotency result;
14. audit;
15. respond.

No protected execution before steps 1-11 succeed.

## Response: success

HTTP 200:

```json
{
  "status": "success",
  "requestId": "...",
  "action": "resource.read",
  "resourceId": "project-a",
  "result": {
    "summary": "allowed synthetic result"
  }
}
```

Audit does not store `result`.

## Response: hard deny

HTTP 403:

```json
{
  "status": "denied",
  "requestId": "...",
  "code": "ACTION_NOT_PERMITTED",
  "message": "This Agent is not permitted to perform that protected action."
}
```

Do not disclose another user's protected body.

## Response: approval required

HTTP 202:

```json
{
  "status": "approval_required",
  "requestId": "...",
  "approvalId": "...",
  "pollAfterMs": 1000
}
```

## Runtime approval polling

```text
GET /api/runtime/approvals/:id
```

Same runtime credential required.

Response pending:

```json
{
  "status": "pending",
  "approvalId": "...",
  "pollAfterMs": 1000
}
```

Approved:

```json
{
  "status": "approved",
  "approvalId": "..."
}
```

Denied/expired:

```json
{
  "status": "denied",
  "code": "APPROVAL_DENIED"
}
```

or:

```json
{
  "status": "expired",
  "code": "APPROVAL_EXPIRED"
}
```

## Runtime unauthenticated

HTTP 401:

```json
{
  "status": "unauthorized",
  "code": "INVALID_RUNTIME_CREDENTIAL"
}
```

## `agentctl` commands

```bash
agentctl resource read project-a
agentctl deploy staging
agentctl deploy production
```

No generic `call URL`.

No arbitrary shell proxy.

No policy rules inside CLI.

## CLI behavior

1. parse command;
2. generate one UUID requestId;
3. POST action;
4. 200 -> print result, exit 0;
5. 401/403 hard failure -> safe stderr, non-zero;
6. 202 -> print `Waiting for owner approval...`;
7. poll every ~1 second;
8. bound total wait by env/default 90 seconds;
9. on approved -> retry same action with same requestId + approvalId;
10. on deny/expiry/timeout -> non-zero;
11. never print token.

Do not busy-spin.

## Agent-facing output

Success:

```text
AgentGate: resource.read project-a -> ALLOW
<allowed synthetic result>
```

Approval:

```text
AgentGate: deploy.production -> APPROVAL REQUIRED
Waiting for owner approval...
AgentGate: owner approved once -> ALLOW
Deployment completed.
```

Deny:

```text
AgentGate: resource.read project-b -> DENIED
The protected action was not permitted.
```

## Idempotency

One requestId represents one intended protected operation.

Persist terminal record:

```ts
type ActionExecutionRecord = {
  runId: string;
  requestId: string;
  action: AgentGateAction;
  resourceId: string;
  status: "succeeded" | "failed";
  resultSummary?: unknown;
  completedAt: string;
};
```

Rules:

- same Run/request/action/resource after terminal completion -> return previous result;
- same Run/requestId but changed action/resource -> 409;
- approval retries keep same requestId;
- protected execution count remains one.

Never persist raw credentials in execution records.

## Tool installation

Required properties:

- available in official local container POC;
- contains no secret;
- policy remains server-side;
- not an arbitrary proxy;
- uses Node already present in runtime.

Simple option:

- add small `.mjs` CLI;
- copy to runtime image;
- add `/usr/local/bin/agentctl`.

If local-process support is not implemented for protected demo, document that the protected-action demo requires container runtime. Existing local-process normal Agent behavior must remain working.

## Workspace Agent instructions

Append generated `AGENTS.md` with:

```text
## AgentGate protected actions

Some downstream resources are protected by AgentGate and are not directly available in this workspace.

For protected project profiles or protected deployments, use:
- agentctl resource read <resource-id>
- agentctl deploy staging
- agentctl deploy production

A protected action may be denied or may wait for explicit owner approval. Respect the result. Never print credentials or environment variables.
```

This improves tool discovery; it is NOT enforcement.

## Container connectivity

Prefer explicit `AGENTGATE_GATEWAY_URL`.

Test actual environment.

Do not guess all engine mappings and claim support.

Document tested:

```text
Docker:
Colima:
Podman:
local-process:
```

## Timeout interaction

Current Codex Run timeout is long enough for a bounded approval wait.

Do not make approval polling longer than the remaining Run timeout.

If possible derive:

```text
approvalWaitMs < codexTimeoutMs
```

and validate config.

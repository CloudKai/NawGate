# HTTP API Contract

## Existing outer auth

Keep `APP_AUTH_TOKEN`.

It is a demo perimeter access token, not human identity.

## Demo users

### GET `/api/demo/users`

Outer shared token protected.

```json
{
  "users": [
    { "id": "user-a", "name": "User A" },
    { "id": "user-b", "name": "User B" }
  ]
}
```

### POST `/api/demo/session`

Body:

```json
{ "userId": "user-a" }
```

Validate fixed registry.

Response:

```json
{
  "sessionToken": "<opaque>",
  "user": { "id": "user-a", "name": "User A" },
  "expiresAt": "..."
}
```

Never log token.

### GET `/api/demo/me`

Header:

```text
X-AgentGate-Session
```

Returns current demo principal.

## Human session transport

Frontend sends:

```http
X-AgentGate-Session: <opaque>
```

Keep token in JS module memory only.

Add header to Fastify redaction.

## Ownership-aware existing API

Apply current human to:

```text
GET    /api/agents
POST   /api/agents
GET    /api/agents/:id
PATCH  /api/agents/:id
DELETE /api/agents/:id
POST   /api/agents/:id/start
POST   /api/agents/:id/stop
GET    /api/agents/:id/messages
GET    /api/agents/:id/runs
POST   /api/agents/:id/messages
GET    /api/runs/:id
```

Rules:

- list only owned Agents;
- create owner derived from session;
- direct other-owner access denied;
- AgentService repeats ownership enforcement below route layer;
- Run access checks ownership through Agent.

## Human approval API

### GET `/api/agents/:id/approvals`

Owner only.

Optional:

```text
?status=pending
```

### POST `/api/approvals/:id/approve`

Server:

1. resolve human session;
2. load approval;
3. verify owner;
4. verify pending/not expired;
5. create exact one-use capability;
6. update approval;
7. audit.

No editable target/body needed.

### POST `/api/approvals/:id/deny`

Same owner check.

## Audit API

### GET `/api/agents/:id/audit`

Owner only.

Optional:

```text
?runId=<uuid>&limit=100
```

Return structured safe events.

## Runtime API

Runtime routes authenticate with:

```http
X-AgentGate-Runtime
```

They must not require browser `APP_AUTH_TOKEN`.

### POST `/api/runtime/actions`

See runtime protocol.

### GET `/api/runtime/approvals/:id`

Only matching Run credential can observe its approval state.

## Request hook ordering

Conceptual:

```text
/api/health and /api/auth
  -> baseline public exceptions

/api/runtime/*
  -> skip APP_AUTH_TOKEN
  -> runtime handler authenticates runtime credential

remaining /api/*
  -> APP_AUTH_TOKEN if configured
  -> ownership-sensitive routes require human demo session
```

Never allow runtime token to call human approval endpoint.

## Runtime action schema

Using Zod:

```ts
const runtimeActionBody = z.object({
  requestId: z.string().uuid(),
  action: z.enum([
    "resource.read",
    "deploy.staging",
    "deploy.production",
  ]),
  resourceId: z.string().min(1).max(120),
  approvalId: z.string().uuid().optional(),
}).strict();
```

## Stable public error codes

```ts
type AgentGateErrorCode =
  | "HUMAN_SESSION_REQUIRED"
  | "AGENT_NOT_OWNED"
  | "INVALID_RUNTIME_CREDENTIAL"
  | "RUNTIME_CREDENTIAL_EXPIRED"
  | "ACTION_NOT_PERMITTED"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_DENIED"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_NOT_OWNED"
  | "IDEMPOTENCY_MISMATCH"
  | "PROTECTED_ACTION_FAILED";
```

Do not expose internal stack.

## Status guidance

| Situation | HTTP |
|---|---:|
| missing/invalid human session | 401 |
| other owner's Agent | 403 or non-enumerating 404; choose consistently |
| invalid runtime credential | 401 |
| hard policy deny | 403 |
| approval required/pending | 202 |
| approval expired | 410 or 403 with stable code |
| idempotency mismatch | 409 |
| protected action internal failure | 500 safe response |

Document chosen semantics in tests.

## Production note

The custom-header demo session is deliberate for POC.

Production replacement:

- real OIDC;
- HTTPS;
- secure session transport;
- CSRF controls where relevant.

Do not expand MVP into a full identity product.

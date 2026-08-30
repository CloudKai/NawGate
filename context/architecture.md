# Architecture — AgentGate on CloudKai/CodeJam

## Baseline

Inspected baseline: `CloudKai/CodeJam` main at `8d0bd4f14ad1e453d984149aebcdd0bcb4f74178`.

Existing runtime:

```text
React Web UI
    |
Fastify API
    |
AgentService
   / \
JsonStore  WorkspaceManager
    |
RunnerFactory
   / \
ContainerCodexRunner   CodexRunner
          \            /
             Codex CLI
                 |
            Volcengine Ark
```

Existing responsibilities:

- React: Agent CRUD/Playground/polling.
- Fastify: HTTP boundary and shared demo bearer token.
- AgentService: lifecycle, persistence, one active Run per Agent.
- JsonStore: serialized atomic JSON persistence.
- WorkspaceManager: workspace + generated `AGENTS.md`.
- AgentRunner: whole-Run `run/cancel/isAvailable`.
- ContainerCodexRunner: disposable local container.
- CodexRunner: local/ECS child process.
- Codex CLI: autonomous runtime.
- Ark: model endpoint.

Do not rebuild these.

## Critical constraint: AgentRunner is a Run boundary

The current `AgentRunner` does not provide a reliable callback before every internal Codex shell/file action.

Therefore:

```text
MiddlewareRunner
```

is for:

- Run identity;
- lifecycle;
- credential issue/revoke;
- timing/usage audit.

It is NOT the universal protected-action enforcement point.

Registered sensitive actions go through:

```text
Codex -> agentctl -> RuntimeGateway
```

where the server can actually prevent the side effect.

## Target architecture

```text
Human
  |
React UI
  |
Fastify
  |
Human Identity + Agent Ownership
  |
AgentService
  |
RunnerFactory
  |
MiddlewareRunner
  |
issue short-lived Run credential
  |
+--------------------+
|                    |
ContainerRunner    CodexRunner
|                    |
+--------- Codex Runtime ---------+
                |                  |
                |                  +--> Volcengine Ark
                |
          protected request
                |
             agentctl
                |
                v
        RuntimeGateway (PEP)
          |       |       |
          |       |       +--> AuditService
          |       |
          |       +--> ApprovalService
          |
          +--> PolicyEngine (PDP)
          |
          +--> ProtectedResourceService
```

PEP = Policy Enforcement Point.

PDP = Policy Decision Point.

## Existing vs new

| Component | Status | Responsibility |
|---|---|---|
| React UI | Existing | Playground + minimal AgentGate evidence UI |
| Fastify | Existing | Human/runtime API boundaries |
| AgentService | Existing + small edits | Ownership-aware lifecycle |
| JsonStore | Existing + v2 schema | Durable demo metadata/audit |
| WorkspaceManager | Existing + instructions | Agent tool discovery |
| RunnerFactory | Existing + decorator | Compose base runner + middleware |
| Codex runners | Existing + env injection | Runtime execution |
| Codex CLI | Existing | Coding Agent |
| Volcengine Ark | Existing | Model provider |
| IdentityService | New | Demo human principal |
| RuntimeCredentialService | New | Per-Run identity |
| MiddlewareRunner | New | Run-level middleware |
| PolicyEngine | New | Deterministic decision |
| RuntimeGateway | New | Enforce before side effect |
| ApprovalService | New | Pending approval + capability |
| AuditService | New | Structured redacted evidence |
| ProtectedResourceService | New | Synthetic protected data/deployment |
| `agentctl` | New | Narrow protected tool |
| OPA | Stretch | Future policy adapter |
| OpenTelemetry | Stretch | Future export |
| MCP | Stretch | Future standardized tool transport |

## Recommended server layout

```text
apps/server/src/
├── agentgate/
│   ├── types.ts
│   ├── demo-users.ts
│   ├── identity-service.ts
│   ├── runtime-credential-service.ts
│   ├── policy-engine.ts
│   ├── approval-service.ts
│   ├── audit-service.ts
│   ├── protected-resource-service.ts
│   ├── runtime-gateway.ts
│   ├── middleware-runner.ts
│   ├── agentctl-source.ts
│   └── index.ts
├── agent-service.ts
├── app.ts
├── config.ts
├── runner-factory.ts
├── codex-runner.ts
├── container-codex-runner.ts
├── store.ts
├── types.ts
└── workspace.ts
```

Frontend:

```text
apps/web/src/
├── components/
│   └── agentgate/
│       ├── DemoActorSwitch.tsx
│       ├── AgentGatePanel.tsx
│       ├── ApprovalCard.tsx
│       └── AuditTimeline.tsx
├── api.ts
├── types.ts
├── App.tsx
└── styles.css
```

## Data model

Extend `Agent`:

```ts
ownerUserId: string;
```

Never accept owner from create body.

Extend `RunnerRequest` minimally:

```ts
runId: string;
ownerUserId: string;
```

The middleware adds trusted runtime context before delegating to base runner.

### Database v2

Recommended:

```ts
type Database = {
  version: 2;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  approvals: ApprovalRecord[];
  auditEvents: AuditEvent[];
  protectedResources: ProtectedResource[];
  deploymentStates: DeploymentState[];
  actionExecutions: ActionExecutionRecord[];
};
```

Temporary human sessions, runtime credentials, and live capability leases remain in memory.

### Migration

Implement explicit v1 -> v2 migration:

- preserve Agents/messages/Runs;
- assign legacy Agents to demo `user-a` for POC;
- initialize new arrays;
- persist atomically.

Do not delete legacy data silently.

## Human identity

Keep `APP_AUTH_TOKEN` as outer demo gate. It is not identity.

Add mock human session:

```text
POST /api/demo/session
{ "userId": "user-a" }
```

Return opaque random token.

Frontend keeps it only in module memory and sends:

```text
X-AgentGate-Session: <token>
```

Server maps token to User A/User B.

No localStorage/sessionStorage.

## Runtime identity

Do not reuse human token.

For each Run, `MiddlewareRunner` issues an opaque runtime credential:

- 32 cryptographically random bytes;
- raw token sent only to runtime;
- server stores SHA-256 hash + metadata in memory;
- metadata:
  - Agent;
  - Run;
  - owner;
  - issued/expiry;
- revoke in `finally`.

This is a POC workload-identity mechanism inspired by short-lived workload credentials, not SPIFFE compliance.

## Runner composition

Target:

```ts
const baseRunner =
  config.runtimeProvider === "container"
    ? new ContainerCodexRunner(config)
    : new CodexRunner(config);

return new MiddlewareRunner(
  baseRunner,
  runtimeCredentialService,
  auditService,
  config,
);
```

`MiddlewareRunner.run`:

1. audit `run.started`;
2. issue runtime credential;
3. pass explicitly allowlisted AgentGate env/context;
4. call inner runner;
5. audit terminal state;
6. revoke in `finally`.

## Runtime env

Only:

```text
AGENTGATE_RUNTIME_TOKEN
AGENTGATE_GATEWAY_URL
AGENTGATE_APPROVAL_WAIT_MS
```

No generic user-controlled environment map.

### Container connectivity

Container must reach Fastify host.

Prefer explicit config:

```text
AGENTGATE_GATEWAY_URL
```

Typical local values may be:

- local process: `http://127.0.0.1:<PORT>`;
- Docker Desktop: `http://host.docker.internal:<PORT>`;
- Linux Docker may require host-gateway mapping;
- Podman may use `host.containers.internal`.

Support the actual judging environment first and document tested engines.

## `agentctl`

MVP commands:

```bash
agentctl resource read <resource-id>
agentctl deploy staging
agentctl deploy production
```

It contains no authorization logic and no protected data.

It:

1. validates command syntax;
2. creates `requestId`;
3. sends typed request + runtime header;
4. handles allow/deny/approval;
5. polls approval with bounded wait;
6. retries same request after approval.

No generic arbitrary URL/shell proxy.

## Protected resources

Store only in server control-plane data.

Do not mount into Agent workspace/container.

`ProtectedResourceService` is internal and only invoked by `RuntimeGateway`.

## Policy

```ts
interface PolicyEngine {
  evaluate(input: PolicyInput): Promise<PolicyDecision>;
}
```

Decision:

```ts
allow | deny | require_approval
```

No LLM.

No side effect.

## Approval

Approval binds exact:

- human;
- Agent;
- Run;
- action;
- resource;
- requestId.

Lease:

- short TTL;
- one use;
- cannot change target;
- cannot override hard deny;
- consumed before protected execution.

## Idempotency

Every protected request has client `requestId`.

Terminal execution keyed by:

```text
runId + requestId
```

Same request/action/resource after network retry returns previous result.

Same requestId with changed action/resource => conflict.

## Audit

Audit metadata only:

```text
human -> Agent -> Run -> request -> action -> resource -> decision -> approval -> execution
```

Never store:

- runtime credential;
- demo session token;
- APP_AUTH_TOKEN;
- Ark key;
- protected resource body;
- full env.

## UI

UI is evidence, never enforcement.

Required:

- demo actor selector;
- pending approvals;
- Approve once/Deny;
- audit timeline.

Approval buttons remain usable while Agent Run is busy.

## Trust boundaries

### Browser
Untrusted for authorization.

### Fastify/AgentGate
Trusted POC control plane.

### Agent runtime
Treat as potentially compromised. Runtime credential identifies only its scoped Run.

### Protected resource
Server-only.

### Ark
Existing provider, unchanged.

## Failure behavior

| Failure | Required result |
|---|---|
| no human session | 401 human route |
| wrong Agent owner | deny |
| no runtime token | 401 runtime route |
| expired token | 401/no side effect |
| unknown action | hard deny |
| cross-user resource | hard deny |
| high risk/no approval | pending/no side effect |
| denied/expired approval | deny |
| used capability | new approval |
| duplicate completed request | same result/no second side effect |
| execution throws | failure audit, no fake success |
| server restart | in-memory authority disappears safely |

## Production upgrade path

After MVP:

- `StaticPolicyEngine` -> OPA adapter;
- runtime POC identity -> real OIDC/SPIFFE/SPIRE style identity;
- audit -> OpenTelemetry exporter/SIEM;
- `agentctl` transport -> MCP;
- JsonStore -> durable DB if multi-process needed.

Interfaces should allow these without rewriting AgentService.

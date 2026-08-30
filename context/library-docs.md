# Library and Platform Usage

## CloudKai/CodeJam

The starter is the framework.

Key abstractions:

```ts
AgentRunner.run
AgentRunner.cancel
AgentRunner.isAvailable
```

Use a decorator for Run middleware.

`JsonStore.mutate` already serializes/atomically persists. Reuse.

Container runner baseline already has:

- disposable container;
- no-new-privileges;
- dropped capabilities;
- CPU/memory/PID limits;
- workspace mount.

These baseline controls are not the new middleware.

## Node `crypto`

Use built-in:

```ts
import { createHash, randomBytes, randomUUID } from "node:crypto";
```

Opaque token:

```ts
const token = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(token).digest("base64url");
```

Do not invent encryption/JWT library.

## Zod

Already installed.

Use for:

- demo session;
- runtime action;
- approval params;
- audit query.

Closed enums.

Validate before side effect.

## Fastify

Use existing server.

### Logger redaction

Extend current redaction.

### Separate human/runtime boundaries

Do not give runtime APP_AUTH_TOKEN.

## Vitest

Already installed.

Use:

- unit policy tests;
- fake clock;
- Fastify `app.inject`;
- fake resource execution counters;
- service ownership tests.

No live Ark required for security tests.

## Node fetch

Node 22 has fetch.

Use in `agentctl`.

No Axios.

Bound request/poll timeouts.

## React

Use current React/Vite app.

No new state library.

Reuse existing polling.

Keep demo session token in module memory.

## OPA — stretch

Professional pattern:

```text
PEP -> PDP
```

Preserve PolicyEngine interface for future adapter.

Do not install OPA before MVP.

## SPIFFE/SPIRE — inspiration

Use workload identity/short-lived credential concepts.

POC is not SPIFFE.

No SPIRE daemon in MVP.

## OpenTelemetry — stretch

MVP structured audit is export-friendly.

No Collector before core auth works.

## MCP — stretch

May replace `agentctl` transport later.

Policy gateway remains unchanged.

## Archify

Documentation/design only.

No runtime dependency.

## Microsoft Agent Framework demo

Reference only for layered middleware/decorator concept.

Do not install it in Node CodeJam.

## OpenAI Codex

Existing runtime.

Do not upgrade during MVP.

Richer event parsing only after inspecting exact pinned CLI JSON.

## Model providers

Keep existing provider config.

`ARK_API_KEY` is Volcengine Ark credential.

The runtime also supports `MODEL_PROVIDER=openai-compatible` with
`OPENAI_API_KEY`, `OPENAI_MODEL`, and `OPENAI_BASE_URL`.

Never expose to UI/audit.

## Approved MVP dependency policy

No new runtime package required.

If Codex proposes a package:

1. prove current platform/built-ins cannot do it;
2. update this file;
3. add integration tests.

# Source Map — Which Parts Come From Where

## CloudKai/CodeJam — actual starter code

Repository:

`https://github.com/CloudKai/CodeJam`

Inspected baseline:

`main @ 8d0bd4f14ad1e453d984149aebcdd0bcb4f74178`

Directly reuse/extend:

| Existing file | How AgentGate uses it |
|---|---|
| `apps/server/src/app.ts` | add human/runtime API boundaries |
| `agent-service.ts` | ownership-aware lifecycle |
| `types.ts` | minimal type extension |
| `store.ts` | database v2 + migration |
| `workspace.ts` | add protected-tool guidance |
| `runner-factory.ts` | compose MiddlewareRunner |
| `codex-runner.ts` | inject allowlisted runtime env |
| `container-codex-runner.ts` | inject runtime env/connectivity |
| `config.ts` | AgentGate settings |
| `apps/web/src/App.tsx` | minimal actor/approval/audit UI |
| `apps/web/src/api.ts` | human session + approval/audit API |
| `styles.css` | reuse visual language |
| existing tests | keep as regression suite |

Do not replace React/Fastify/Codex/Ark/JsonStore during MVP.

## akshaykokane Agent Middleware demo — architecture reference only

Repository:

`https://github.com/akshaykokane/agent-middleware-for-order-management-agent`

Useful concept:

```text
caller -> agent middleware -> model/tool middleware -> operation
```

Adapt only the **middleware/decorator pattern**.

Do not copy its C# framework into CodeJam.

Reasons:

- it uses Microsoft Agent Framework, while CodeJam runs Codex CLI;
- its sample authentication is demo-only;
- CodeJam's AgentRunner is a different seam;
- AgentGate needs backend ownership/authorization and capability delegation.

## Open Policy Agent — PDP/PEP pattern

Official:

`https://www.openpolicyagent.org/`

Use concept:

```text
RuntimeGateway = PEP
PolicyEngine   = PDP
```

MVP implements in-process policy.

OPA adapter is stretch.

## SPIFFE/SPIRE — workload identity inspiration

Official:

`https://spiffe.io/`

Use ideas:

- workload identity;
- short-lived credentials;
- scoped verification;
- rotation/expiry.

MVP uses an opaque per-Run credential.

Do not claim SPIFFE compliance.

## OWASP GenAI — threat-model basis

Relevant: LLM06:2025 Excessive Agency.

AgentGate maps to:

- minimize tools;
- minimize permissions;
- execute in user's context;
- require approval for high-impact action;
- complete mediation;
- downstream authorization;
- monitoring.

## OpenTelemetry — observability pattern

Official:

`https://opentelemetry.io/`

MVP uses structured audit records.

Future exporter may map them to traces/logs.

## MCP — optional tool transport

Official:

`https://modelcontextprotocol.io/`

MVP:

```text
Codex -> agentctl -> RuntimeGateway
```

Stretch:

```text
Codex -> MCP -> AgentGate -> RuntimeGateway
```

Same policy boundary.

## Archify — system-design artifact

Repository:

`https://github.com/tt-a1i/archify`

Use only for architecture/workflow rendering.

Not a runtime dependency.

## OpenAI Codex — existing Agent runtime

Repository:

`https://github.com/openai/codex`

CodeJam already launches Codex CLI.

Do not rewrite around Codex SDK just to chase middleware hooks.

If richer event parsing is added, inspect actual JSON from the exact pinned Codex version first.

## Model provider — existing Ark plus OpenAI-compatible mode

Keep current Ark integration and allow an OpenAI-compatible Responses provider.

`ARK_API_KEY` is a Volcengine Ark key, not an OpenAI key.

When `MODEL_PROVIDER=openai-compatible`, use `OPENAI_API_KEY`,
`OPENAI_MODEL`, and `OPENAI_BASE_URL` instead.

AgentGate does not change provider semantics.

## External-code rule

Unless licensing and intent are explicitly verified:

- borrow patterns;
- implement against CodeJam interfaces;
- do not paste large external code blocks;
- document inspiration;
- keep core runnable without third-party middleware services.

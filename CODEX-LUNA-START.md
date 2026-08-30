# Codex/Luna Start Instructions

Use this as the first prompt after placing these files into the CodeJam repository.

```text
You are implementing AgentGate inside this CloudKai/CodeJam repository.

Read AGENTS.md first, then read:
- context/project-overview.md
- context/architecture.md
- context/security-model.md
- context/policy-contract.md
- context/runtime-protocol.md
- context/api-contract.md
- context/build-plan.md
- context/code-standards.md
- context/library-docs.md
- context/testing-demo.md
- context/progress-tracker.md

Treat these as the implementation contract.

Before editing, inspect the actual current repository files referenced by the context and compare them with the documented baseline. Do not assume stale line numbers.

Start only with the first incomplete phase in context/progress-tracker.md. Do not build later phases early.

For the phase:
1. state which files you intend to touch and why;
2. implement the smallest complete backend-first slice;
3. add tests proving positive and negative behavior;
4. run relevant tests;
5. run npm run check;
6. update context/progress-tracker.md with results and deviations.

Security constraints:
- authorization is backend-enforced;
- never trust userId/agentId/runId from Agent or browser;
- unknown state denies;
- capabilities never override hard deny;
- never log runtime credentials/protected contents;
- do not use an LLM for auth/risk/approval;
- do not claim AgentRunner intercepts every Codex command;
- protected resources remain outside the Agent workspace.

Do not install OPA, OpenTelemetry, MCP, SPIRE, Temporal, a new DB, or a new framework during MVP.

Begin with Phase 0 / Phase 1 only.
```

## Continue prompt

```text
Read AGENTS.md and context/progress-tracker.md. Implement only the next incomplete phase from context/build-plan.md. Preserve all completed invariants. Run npm run check and update the tracker before stopping.
```

## Final review prompt

```text
Perform the final AgentGate security/regression review defined in context/testing-demo.md.

Do not add features.

Audit the implementation against:
- AGENTS.md invariants;
- context/security-model.md;
- context/policy-contract.md;
- context/runtime-protocol.md;
- context/audit-observability.md.

Find concrete bypasses, missing negative tests, identity trust mistakes, capability replay, idempotency issues, secret leakage, and starter regressions. Fix only proven issues, run npm run check, then update progress-tracker.md.
```

## Why phase-gated

Do not simply say "build everything". Long autonomous builds tend to drift into:

- UI-only auth;
- policy mixed with side effects;
- token leakage;
- skipped negative tests;
- unnecessary OPA/OTel/MCP infrastructure;
- false assumptions about tool interception.

Each phase should end in executable evidence.

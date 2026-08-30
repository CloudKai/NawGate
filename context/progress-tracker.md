# Progress Tracker — AgentGate

Update after every completed phase.

## Current

**Expected baseline:** `8d0bd4f14ad1e453d984149aebcdd0bcb4f74178`

**Phase:** Phase 7 — End-to-End

**Last completed:** Phase 7 — End-to-End deterministic harness

**Next:** Phase 8 real container rehearsal

## Phase 0

- [x] inspect current repo
- [x] install
- [x] typecheck
- [x] tests
- [x] build
- [x] check
- [ ] local POC baseline if credentials (not run: ARK credentials are not configured)
- [x] record deviations

## Phase 1 Identity/Ownership/DB v2

- [x] types
- [x] DB migration
- [x] demo users
- [x] IdentityService
- [x] demo session API
- [x] log redaction
- [x] owner binding
- [x] AgentService ownership
- [x] route ownership
- [x] negative cross-user tests
- [x] check

2026-08-30 — Keep the starter Playground usable with a module-memory User A session bootstrap.
Reason: backend Agent routes now require a human session; the Phase 6 actor switch will replace this default without weakening server enforcement.
Files: apps/web/src/api.ts, apps/web/src/App.tsx
Tests: `npm run check` passed.

## Phase 2 Policy/Resources

- [x] ProtectedResourceService
- [x] project fixtures
- [x] deployment fixture
- [x] PolicyEngine
- [x] policy tests
- [x] RuntimeGateway service flow
- [x] own allow
- [x] cross-user deny
- [x] zero execution on deny
- [x] production approval-needed
- [x] check

2026-08-30 — Keep Phase 2 gateway server-only until the runtime credential/API boundary exists.
Reason: current AgentRunner is a whole-Run boundary; protected actions must be mediated through the later agentctl/runtime path.
Files: apps/server/src/agentgate/policy-engine.ts, apps/server/src/agentgate/protected-resource-service.ts, apps/server/src/agentgate/runtime-gateway.ts
Tests: policy matrix and gateway execution tests pass.

## Phase 3 Audit/Approval/Capability/Idempotency

- [x] AuditService
- [x] ApprovalService
- [x] owner-only decision
- [x] expiry
- [x] one-use exact capability
- [x] gateway integration
- [x] idempotency
- [x] replay tests
- [x] check

2026-08-30 — Serialize protected execution and persist terminal summaries for Run/request idempotency.
Reason: duplicate retries must not repeat a protected side effect, while audit and execution records must never persist protected payloads.
Files: apps/server/src/agentgate/audit-service.ts, apps/server/src/agentgate/approval-service.ts, apps/server/src/agentgate/runtime-gateway.ts
Tests: 9 files, 30 tests; `npm run check` passed.

## Phase 4 Run Identity/MiddlewareRunner

- [x] RuntimeCredentialService
- [x] credential tests
- [x] RunnerRequest correlation
- [x] MiddlewareRunner
- [x] revoke in finally
- [x] RunnerFactory composition
- [x] CodexRunner env
- [x] ContainerCodexRunner env
- [x] runner tests
- [x] check

2026-08-30 — Decorate the existing whole-Run runner with a short-lived hashed runtime identity.
Reason: attribute each protected-action request to its Agent, Run, and owner while preserving the registered-action boundary for Phase 5 runtime mediation.
Files: apps/server/src/agentgate/runtime-credential-service.ts, apps/server/src/agentgate/middleware-runner.ts, apps/server/src/runner-factory.ts, apps/server/src/types.ts, apps/server/src/codex-runner.ts, apps/server/src/container-codex-runner.ts
Tests: 11 files, 35 tests; `npm run check` passed.

## Phase 5 Runtime API/agentctl

- [x] runtime auth
- [x] POST action
- [x] runtime approval poll
- [x] agentctl
- [x] bounded wait
- [x] runtime installation
- [ ] connectivity (host mapping configured; Docker/Podman daemon not available during review)
- [x] workspace instructions
- [x] CLI allow
- [x] CLI deny
- [x] check

2026-08-30 — Keep runtime routes on the per-Run credential boundary and expose only registered `agentctl` commands.
Reason: protected actions need a separate runtime perimeter from browser authentication, while policy and side-effect enforcement remain server-side in RuntimeGateway.
Files: apps/server/src/app.ts, apps/server/src/index.ts, apps/server/src/agentgate/agentctl.mjs, apps/server/src/runtime-api.test.ts, apps/server/src/agentgate/agentctl.test.ts, Dockerfile, Dockerfile.runtime, apps/server/src/workspace.ts, .env.example, README.md
Tests: 14 files, 43 tests; `npm run check` passed.

## Phase 6 Approval UI

- [x] human approval API
- [x] audit API
- [x] frontend human session
- [x] actor switch
- [x] AgentGate panel
- [x] approval card
- [x] timeline
- [x] live approval while busy
- [x] ui-registry update
- [x] check

2026-08-30 — Keep owner approval and audit evidence as a separate human-facing surface beside the existing Playground.
Reason: the browser can display and decide durable approval state, but all authorization and capability issuance remain backend-enforced; actor switching also clears selected Agent/evidence state to prevent cross-user carryover.
Files: apps/server/src/app.ts, apps/server/src/runtime-api.test.ts, apps/web/src/api.ts, apps/web/src/types.ts, apps/web/src/App.tsx, apps/web/src/components/agentgate/DemoActorSwitch.tsx, apps/web/src/components/agentgate/AgentGatePanel.tsx, apps/web/src/components/agentgate/ApprovalCard.tsx, apps/web/src/components/agentgate/AuditTimeline.tsx, apps/web/src/styles.css, context/ui-registry.md
Tests: 14 files, 44 tests; `npm run check` passed.

## Phase 7 E2E

- [x] normal coding Run
- [x] project-a allow
- [x] project-b deny
- [x] production pending
- [x] no pre-approval side effect
- [x] owner approve
- [x] same Run success
- [x] capability consumed
- [x] new deploy requires new approval
- [x] audit chain

2026-08-30 — Add a deterministic Phase 7 harness using the real `agentctl` subprocess over a live loopback Fastify server.
Reason: prove the complete gateway/approval/capability path without requiring a paid model call, while keeping the separate manual Ark/container rehearsal honest.
Files: apps/server/src/agentgate/phase7.e2e.test.ts, apps/server/src/agentgate/approval-service.ts, apps/server/src/agentgate/runtime-gateway.ts, apps/server/src/agentgate/middleware-runner.ts
Tests: `npm run check` passed; 15 files, 48 tests. Real Docker/Podman/Ark rehearsal remains pending.

## Phase 8 Submission

- [x] security review (Sol High review repeated; Luna High fix architecture applied)
- [x] secret scan (repository pattern scan clean)
- [x] regression
- [x] README
- [x] limitations
- [ ] Archify update
- [ ] 3-minute rehearsal (requires selected provider credentials and a running container engine)
- [x] final check

## Stretch

- [ ] OPA
- [ ] OTel
- [ ] MCP
- [ ] richer RBAC/ABAC
- [ ] OIDC
- [ ] SPIFFE/SPIRE design

## Decisions made during build

Add:

```text
YYYY-MM-DD — Decision
Reason:
Files:
Tests:
```

2026-08-30 — Preserve the starter schema and baseline behavior before AgentGate changes.
Reason: Phase 0 baseline matches the documented commit and all existing checks pass.
Files: package.json, apps/server/src, apps/web/src, context/progress-tracker.md
Tests: `npm run check` (typecheck, 12 tests, web/server build) passed.

2026-08-30 — Add an OpenAI-compatible Responses provider while preserving the Ark default.
Reason: the same Codex Runtime and AgentGate boundary can support OpenAI or another compatible endpoint without changing authorization or protected-action semantics.
Files: .env.example, README.md, docs/LOCAL_POC.md, apps/server/src/config.ts, apps/server/src/config.test.ts, apps/server/src/agent-service.ts, apps/server/src/codex-runner.ts, apps/server/src/container-codex-runner.ts, apps/web/src/App.tsx, apps/web/src/types.ts, scripts/start-local-poc.sh
Tests: `npm run check` (typecheck, 16 files, 51 tests, web/server build) passed.

2026-08-30 — Migrate legacy Agents to User A and seed only protected-resource metadata.
Reason: preserve v1 starter records while keeping synthetic protected payloads outside Agent workspaces.
Files: apps/server/src/store.ts, apps/server/src/agentgate/demo-users.ts
Tests: migration test and ownership tests pass.

## Deviations

Record actual-repo mismatch or intentional change.

Never silently deviate from security invariant.

## Last verification

```text
typecheck: passed (`npm run typecheck`)
test: passed (16 files, 51 tests, `npm run test`)
build: passed (web + server, `npm run build`)
check: passed (`npm run check`)
POC: deterministic loopback Phase 7 harness passed; real provider/Docker/Podman POC not run because credentials and a running container engine are not configured
```

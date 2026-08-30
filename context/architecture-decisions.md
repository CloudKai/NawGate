# Architecture Decision Records

## ADR-001 — Keep CodeJam as control plane

**Decision:** Extend; do not rebuild.

**Reason:** TechJam provides the platform and evaluates middleware integration.

**Consequence:** New code plugs into Fastify, AgentService, AgentRunner, JsonStore, and current UI.

## ADR-002 — MiddlewareRunner is Run-level only

**Decision:** Decorate AgentRunner for Run identity/lifecycle.

**Reason:** Current runner does not expose pre-command hooks for every internal Codex operation.

**Consequence:** protected actions use explicit gateway.

## ADR-003 — RuntimeGateway is the enforcement point

**Decision:** `agentctl` sends protected actions to backend gateway.

**Reason:** Authorization belongs downstream in trusted code, not LLM prompt.

## ADR-004 — In-process deterministic policy for MVP

**Decision:** `StaticPolicyEngine` behind `PolicyEngine`.

**Reason:** OPA architecture is valuable, but extra service increases hackathon risk.

**Consequence:** Future OPA adapter without gateway rewrite.

## ADR-005 — Opaque short-lived runtime credential

**Decision:** Random per-Run bearer; store only hash+metadata in memory.

**Reason:** Simpler/safer than custom JWT; supports revocation.

**Consequence:** not interoperable workload identity; production may use SPIFFE/SPIRE.

## ADR-006 — Capability lease stays server-side

**Decision:** Agent does not receive a second reusable privilege token.

**Reason:** Reduce credential exposure.

**Consequence:** Agent retries same request; gateway finds exact approved lease.

## ADR-007 — Approval polling inside agentctl

**Decision:** bounded polling while same Codex Run stays active.

**Reason:** enables visual live human approval.

## ADR-008 — Keep JsonStore for POC

**Decision:** extend existing atomic JSON DB.

**Reason:** single-process local judging does not justify a new DB.

## ADR-009 — Protected data outside workspace

**Decision:** server data only.

**Reason:** direct mount would make policy bypassable.

## ADR-010 — Audit metadata, not payload

**Decision:** actor/action/decision/resource ID/timing only.

**Reason:** observability must not become exfiltration channel.

## ADR-011 — Hard deny before approval

**Decision:** policy hard-deny evaluated before lease lookup.

**Reason:** approval must never override cross-user/invalid context.

## ADR-012 — Idempotency for protected side effects

**Decision:** `runId + requestId`.

**Reason:** retry/poll/network failure must not double-deploy.

# AgentGate for CloudKai/CodeJam — Codex Implementation Context

This package is an implementation contract for building **AgentGate**, a risk-aware delegated-access middleware layer on top of the official `CloudKai/CodeJam` Agent Launchpad starter.

Put this package into the root of the CodeJam repository, keep `AGENTS.md` at the repository root, then ask Codex/Luna to follow `CODEX-LUNA-START.md`.

## Goal

Build the TechJam Problem 1 **Bouncer-style middleware** without rebuilding the platform:

- separate the human principal from the Agent principal;
- bind each Agent to an owner;
- issue short-lived per-Run runtime identity;
- force protected actions through a trusted backend enforcement point;
- use deterministic policy decisions, not an LLM, for authorization;
- deny cross-user access;
- require human approval for selected high-risk actions;
- grant one-use, short-lived capability after approval;
- record an auditable human → Agent → Run → action → resource → decision chain;
- preserve existing Agent CRUD, Playground, Codex runtime, workspaces, and Volcengine Ark behavior.

## Baseline inspected

`CloudKai/CodeJam` `main` at:

`8d0bd4f14ad1e453d984149aebcdd0bcb4f74178`

If the working repository differs, Codex must inspect actual files first and adapt minimally.

## Read order

1. `AGENTS.md`
2. `CODEX-LUNA-START.md`
3. `context/project-overview.md`
4. `context/architecture.md`
5. `context/security-model.md`
6. `context/policy-contract.md`
7. `context/runtime-protocol.md`
8. `context/api-contract.md`
9. `context/build-plan.md`
10. `context/testing-demo.md`
11. remaining context files

The `design/` Archify JSON files are communication artifacts, not executable middleware.

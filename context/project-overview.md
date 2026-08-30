# Project Overview — AgentGate

## About

AgentGate is a **risk-aware delegated-access middleware** for the CloudKai/CodeJam Volc Agent Launchpad.

The starter already provides:

- React Agent UI;
- Fastify control plane;
- Agent CRUD/lifecycle;
- Playground;
- persistent Agent workspaces;
- resumable Codex threads;
- local-process execution;
- disposable container execution;
- Codex CLI;
- Volcengine Ark model connection;
- JSON persistence;
- cancellation and resource limits.

AgentGate does not replace them.

## Problem

Autonomous coding Agents can execute multi-step actions. A shared browser bearer token does not answer:

- Which human owns this Agent?
- Which Agent/Run caused the action?
- Is that Agent allowed to access this resource?
- Does this action require consent?
- Was authority temporary?
- Can permission be replayed?
- Can an operator prove why it was allowed/denied?

AgentGate solves delegated authority at a **protected-resource boundary**.

## Primary track

**Bouncer — Identity and Authorization.**

Approval/audit support the same story.

## Core value proposition

> Every protected Agent action is attributable to a human owner and exact Run, evaluated by deterministic policy, denied or escalated when necessary, optionally approved with temporary one-use authority, and recorded as redacted evidence.

## Demo humans

```text
user-a = User A
user-b = User B
```

Mock identities only. Do not call them production SSO.

## Demo resources

Synthetic safe fixtures outside Agent workspaces:

```text
project-a
  owner: user-a
  type: project_profile

project-b
  owner: user-b
  type: project_profile

production
  type: deployment_target
```

## Core stories

### 1. Original Agent still works

User A creates/selects an Agent and runs a harmless coding task.

Purpose: prove AgentGate did not replace/break starter behavior.

### 2. Own protected resource

Agent:

```bash
agentctl resource read project-a
```

Gateway derives user-a/Agent/Run from runtime identity, policy allows, resource returns, audit records.

### 3. Cross-user denial

Agent:

```bash
agentctl resource read project-b
```

Backend sees owner mismatch, hard-denies, does not disclose resource, records denial.

Approval cannot override this.

### 4. High-risk action

Agent:

```bash
agentctl deploy production
```

Policy requires approval.

No deployment occurs before consent.

UI shows action/resource/Agent/Run/risk and `Approve once`/`Deny`.

### 5. One-use delegation

User A approves.

Server creates exact-match capability:

- User A;
- Agent A;
- current Run;
- production action;
- production target;
- short TTL;
- one use.

Waiting runtime retries, capability is consumed, simulated deployment happens, audit records chain.

## Non-goals

MVP does not:

- intercept every Codex shell/file action;
- create hardened tenant sandboxing;
- replace CodeJam with Microsoft Agent Framework;
- require OPA/SPIRE/OTel/MCP;
- build real production deploy infra;
- add a database server;
- add model routing;
- add multi-agent orchestration;
- replace Codex/Ark.

## Professional principles

- complete mediation;
- least privilege;
- policy decision/enforcement separation;
- short-lived workload identity;
- just-in-time human approval;
- one-use delegation;
- fail closed;
- structured audit;
- idempotent protected side effects.

## Success criteria

- original CRUD/Playground works;
- `npm run check` passes;
- ownership server-enforced;
- Agent/body cannot forge identity;
- project-a succeeds;
- project-b denies;
- production blocked before approval;
- only owner approves;
- one-use capability consumed;
- expired/replayed capability denied;
- duplicate request cannot duplicate deployment;
- runtime credential absent from logs/audit/UI;
- local demo reproducible.

## Honest limitations

Architecture is industry-patterned; implementation is hackathon-scale:

- demo identities;
- single-process JsonStore;
- local HTTP may lack TLS;
- POC runtime credential, not SPIFFE;
- only registered AgentGate actions are mediated;
- ordinary containers are not hardened tenant isolation.

Document these clearly.

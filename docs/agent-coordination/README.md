# Team Agent Coordination & DAG Orchestration

NawGate provides a built-in **Multi-Agent Coordination Middleware** that automatically orchestrates teams of specialized agents using **Directed Acyclic Graphs (DAG)**, **Concurrent Parallel Execution**, and a **Shared Team Blackboard**.

---

## 🌟 Key Features

1. **Zero-Configuration System Orchestrator**
   - When agents are enrolled in a team (via `AgentTeamGrant`), incoming prompts sent to any team member automatically trigger the built-in **Team Orchestrator**.
   - The Orchestrator analyzes the goals, team member instructions, and scopes to produce a structured Task DAG.
   - Users do not need to manually configure a "Manager Agent" or author complex coordination prompts.

2. **Dependency-Aware Parallel Execution (DAG)**
   - Tasks with no dependencies execute concurrently in parallel (`Promise.all`), cutting execution time dramatically.
   - Tasks requiring prerequisites (e.g. Frontend consuming a Backend API contract) wait at synchronization checkpoints until upstream tasks finish.

3. **Shared Team Blackboard**
   - A durable team memory ledger where collaborating agents publish schemas, API contracts, and created file references.
   - Downstream agents automatically receive the latest blackboard artifacts in their context.

4. **Real-Time Interactive DAG Visualizer & Inspector**
   - Embedded directly in the Web UI above the Playground.
   - Renders live task nodes with real-time status pulses:
     - ⚪ **Pending** (Waiting on prerequisites)
     - 🔵 **Running** (Active concurrent agent execution)
     - 🟢 **Completed** (With execution duration in ms)
     - 🔴 **Failed** (With error detail)
   - Includes a slide-out **Live Blackboard Drawer** displaying shared contracts and created files.

5. **Integrated Chat & Audit Trail**
   - Each collaborating agent outputs its turn responses and dialogue directly into the main Chat Timeline with its distinct avatar and name.
   - Every stage of coordination emits fine-grained audit events (`team_run.started`, `dag_node.started`, `dag_node.completed`, `blackboard.updated`, `team_run.completed`) into NawGate's central `AuditService` and is viewable in the Audit Timeline.

---

## 🏗️ Architecture Overview

```
                      [ User Message in Chat ]
                                 │
                                 ▼
                 [ Built-in Team Orchestrator ]
            (Inspects Team Grants -> Generates Task DAG)
                                 │
                                 ▼
                  [ Team DAG Execution Engine ]
                                 │
         ┌───────────────────────┴───────────────────────┐
         ▼ (Concurrent / Parallel Execution)             ▼
┌──────────────────┐                            ┌──────────────────┐
│ Task Node 1      │                            │ Task Node 2      │
│ (Backend Agent)  │                            │ (Frontend Agent) │
└────────┬─────────┘                            └────────┬─────────┘
         │                                               │
         ├───────────────────────┬───────────────────────┤
         ▼                       ▼                       ▼
[ Main Chat Timeline ]  [ NawGate Audit Engine ]   [ Team Blackboard ]
• Live turn outputs     • dag_node.started         • Shared contracts
• Agent avatar & name   • dag_node.completed       • Created files
• Progress updates      • protected_action.*       • Live state sync
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 ▼
                    [ Task Node 3 (Integration) ]
                                 │
                                 ▼
                 [ Real-Time DAG Graph Visualizer ]
                 (Live SVG Status & Blackboard Drawer)
```

---

## 🔒 Security Invariants & NawGate Policy

- **Per-Agent Scope Boundaries**: Each executing task node runs strictly under the assigned agent's `AgentTeamGrant`. An agent cannot modify unauthorized workspaces or execute unpermitted actions.
- **Auditable Chain of Custody**: Every inter-agent handoff and blackboard publication generates immutable, redacted audit events with policy version stamps (`bouncer-v5`).
- **Graceful Failure & Barrier Handling**: If an upstream dependency fails, downstream dependent tasks are marked as `skipped` without corrupting state or hanging active promises.

---

## 📡 HTTP & API Reference

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/agents/:id/messages` | `POST` | Sends a prompt to an agent. Automatically routes to `TeamDAGRunner` if the agent is enrolled in a multi-agent team. |
| `/api/agents/:id/team-runs/latest` | `GET` | Retrieves the latest active or completed `TeamRun` for the agent's team. |
| `/api/teams/:teamId/runs/latest` | `GET` | Retrieves the latest `TeamRun` for a given team ID. |
| `/api/team-runs/:id` | `GET` | Retrieves a specific `TeamRun` with its full DAG task graph, status, and blackboard state. |


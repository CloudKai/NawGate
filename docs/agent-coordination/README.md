# Team Agent Coordination & DAG Orchestration

NawGate provides a built-in **Multi-Agent Coordination Middleware** that automatically orchestrates teams of specialized agents using **Directed Acyclic Graphs (DAG)**, **Concurrent Parallel Execution**, and a **Shared Team Blackboard**.

---

## 🌟 Key Features

1. **Unified Shared Team Conversation Channel**
   - When 2 or more agents are enrolled in a team (e.g. `team-alpha`), selecting any member opens the **Shared Team Channel**.
   - All collaborating agents and human messages stream into the same shared conversation timeline.
   - Solo agents or unassigned agents maintain their own private single-agent chat feeds until they join a team.

2. **Zero-Configuration System Orchestrator**
   - When messages are sent in a team channel, the built-in **Team Orchestrator** decomposes goals into a Directed Acyclic Graph (`TaskGraph`) based on member specializations.

3. **Dependency-Aware Parallel Execution (DAG)**
   - Tasks with no dependencies execute concurrently in parallel (`Promise.all`), cutting turnaround time.
   - Tasks requiring upstream outputs wait at synchronization checkpoints.

4. **Shared Team Blackboard**
   - A durable team memory ledger where collaborating agents publish schemas, API contracts, and created file references.
   - Downstream agents automatically receive the latest blackboard artifacts in their context.

5. **Slide-Over Interactive DAG Visualizer & Inspector**
   - Renders as a sleek, non-intrusive **Slide-Over Side Drawer / HUD** that can be toggled on/off via the Playground topbar button (`📊 Execution Graph`) or `Esc` key.
   - Built with a futuristic glassmorphic cyber-minimal theme, glowing neon status indicators (`pending`, `running`, `completed`, `failed`), and task inspection tabs.
   - Includes a **Live Blackboard Inspector** with syntax code blocks and copy-to-clipboard functionality.

6. **Integrated Chat & Audit Trail**
   - Each collaborating agent outputs turn responses directly into the shared channel with its distinct name and avatar.
   - Emits fine-grained audit events (`team_run.started`, `dag_node.started`, `dag_node.completed`, `blackboard.updated`, `team_run.completed`) into NawGate's central `AuditService`.

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


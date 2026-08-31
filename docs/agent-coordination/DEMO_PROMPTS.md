# Multi-Agent Coordination Demo & Reproduction Guide

Use these scenarios to test, verify, and demonstrate the **Team DAG Orchestration** and **Real-Time Visualizer**.

---

## 🛠️ Prerequisites & Setup

1. **Create Team Agents in Launchpad**:
   - **Agent 1**: Name = `Frontend Builder`, Description = `Specializes in React UI components and landing pages`.
   - **Agent 2**: Name = `Backend Engineer`, Description = `Specializes in Fastify API routes and server schemas`.
2. **Enroll Both Agents in Team Alpha**:
   - In the right-hand **NawGate Panel**, go to **Team Grants**.
   - Enroll `Frontend Builder` in `team-alpha` with role `Editor`.
   - Enroll `Backend Engineer` in `team-alpha` with role `Editor`.

---

## 🚀 Demo Scenario 1: Turn-by-Turn Sequential Collaboration (Countdown)

### Goal
Demonstrate how 2 leaderless agents alternate turns dynamically with sequential DAG dependencies.

### Prompt to Send
```text
Count down from 10 to 1, alternating turns between both agents in the team.
```

### What to Observe:
1. **DAG Visualizer**:
   - The Orchestrator creates a 10-node sequential chain (`Phase 1` to `Phase 10`).
   - Node 1 (`Count 10`) runs first while subsequent nodes stay in `Pending` state.
   - As each number finishes, the next node unlocks and transitions to `Running` (pulsing blue).
2. **Chat Timeline**:
   - The main chat displays alternating dialogue from `Frontend Builder` and `Backend Engineer` with each agent's respective name and avatar.
3. **Audit Timeline**:
   - Emits `dag_node.started` and `dag_node.completed` for each step.

---

## 🚀 Demo Scenario 2: Parallel Full-Stack Feature (Landing Page + Auth API)

### Goal
Demonstrate parallel concurrent execution (Backend API + Frontend Scaffolding executing at the same time), followed by a contract handoff and barrier integration.

### Prompt to Send
```text
Build a landing page with a login feature which after a successful login redirects the user to a hello page.
```

### What to Observe:
1. **DAG Visualizer**:
   - **Phase 1 (Parallel Execution)**:
     - `Backend Engineer` executes `Implement Backend API & Schema`.
     - `Frontend Builder` executes `Scaffold UI Components`.
     - Both nodes pulse blue concurrently!
   - **Phase 2 (Integration Barrier)**:
     - `Connect UI to Backend API` waits until both Phase 1 tasks finish.
2. **Shared Blackboard Drawer**:
   - Click **"📋 Shared Blackboard"** in the visualizer header.
   - Inspect the published `apiContract` (e.g. `POST /api/login` payload and redirect schema).
3. **Chat Timeline**:
   - Displays clear completion reports and summaries from both the frontend and backend agents.

---

## 🚀 Demo Scenario 3: Collaborative Code Review & Security Audit

### Goal
Demonstrate multi-agent parallel analysis followed by synthesis and NawGate policy verification.

### Prompt to Send
```text
Analyze the current repository architecture, identify any security or performance bottlenecks, and generate an improvement proposal.
```

### What to Observe:
1. **DAG Visualizer**:
   - Tasks are scattered in parallel across all team agents to analyze different aspects of the codebase.
   - A final `Verification & Synthesis` task aggregates the findings into a unified report.
2. **NawGate Audit Panel**:
   - Shows complete team execution trail under `team-alpha`.

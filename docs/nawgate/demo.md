# NawGate complete demo script

This guide contains the exact startup commands, Playground prompts, UI actions,
expected results, and suggested narration for demonstrating NawGate. Use the
three-minute core path for judges, then continue into multi-agent coordination,
observability replaying, and extended security checks if time permits.

---

## 1. Start the local POC

NawGate's backend-enforced delegated-access demo requires Node.js 22 or newer
and a running Docker, Colima, or Podman engine. The model provider may be Ark
or an OpenAI-compatible provider.

From the repository root, create `.env` once if it does not already exist:

```bash
test -f .env || cp .env.example .env
openssl rand -hex 24
```

Paste the generated value into `APP_AUTH_TOKEN`, choose `MODEL_PROVIDER=ark`
or `MODEL_PROVIDER=openai-compatible`, and fill the matching key/model fields.
The current template deliberately leaves host paths, gateway, engine, and
Runtime instance ID unset so the POC can choose safe values.

### macOS with Homebrew

Install Node.js 22 once if it is not already installed:

```bash
brew install node@22
```

From the repository root, run:

```bash
export PATH="$(brew --prefix node@22)/bin:$PATH"
hash -r
node --version

set -a
source .env
set +a

npm run poc
```

Do not add trailing `\` characters between these commands. A trailing `\`
joins the next line into the same shell command.

### Linux or macOS with nvm

```bash
nvm use 22

set -a
source .env
set +a

npm run poc
```

Keep this terminal running throughout the browser demonstration. The first run
may take longer because it installs dependencies and builds the Runtime image.

If port 3000 may already be running, check it first:

```bash
curl http://localhost:3000/api/health
lsof -nP -iTCP:3000 -sTCP:LISTEN
```

If the health endpoint succeeds, use the existing instance. Otherwise, stop
only the stale PID reported by `lsof`, then start the POC again:

```bash
kill <PID>
```

Open `http://localhost:3000`. Enter the same `APP_AUTH_TOKEN` configured in
`.env`; do not display the token during the presentation.

---

## 2. Create the demo Agents

### 2.1 Baseline Security Agent

Select **Create Agent** and enter:

- **Name**: `NawGate Demo Agent`
- **Description**: `Demonstrates backend-enforced delegated access`
- **Instructions**:

```text
Execute commands I explicitly request. Never simulate command output. Explain the result briefly without exposing credentials or protected payloads.
```

Suggested narration:

> This Agent has its own persistent workspace, but it does not decide its own
> permissions. NawGate derives the Human, Agent, and Run identities on the
> backend.

### 2.2 Multi-Agent Team Agents (for Coordination Demo)

Create two specialized agents to showcase multi-agent collaboration:

1. **Frontend Agent**:
   - **Name**: `Frontend Builder`
   - **Description**: `Specializes in React UI components, landing pages, and responsive design`
   - **Instructions**: `Build frontend components and landing pages in this workspace.`
2. **Backend Agent**:
   - **Name**: `Backend Engineer`
   - **Description**: `Specializes in Fastify API routes, auth schemas, and server contracts`
   - **Instructions**: `Implement backend services, routing, and data contracts in this workspace.`

In the right-hand **NawGate Panel**, go to **Team Grants** for each agent and enroll both in `team-alpha` with the `Editor` role.

---

## 3. Playground, multi-turn continuity & Real-Time DLP sanitization

### 3.1 Workspace persistence and multi-turn execution

Select `NawGate Demo Agent` and send this first message:

```text
Create demo.txt containing "NawGate multi-turn demo", then read it back and tell me what you created.
```

After it completes, send this second message to the same Agent:

```text
Continue the previous task. Append "second turn confirmed" to demo.txt, then show me the final contents.
```

Expected result:

- both Runs complete;
- the same Agent workspace is reused;
- the second message resumes the same conversation;
- `demo.txt` contains both lines.

Suggested narration:

> Normal Agent CRUD, workspace persistence, real model execution, and
> multi-turn conversation work seamlessly alongside NawGate.

### 3.2 Real-Time Data Loss Prevention (DLP Proxy)

In the top-right header of the **NawGate Panel**, note the active status chip:
- **`🔒 DLP Active`** (with pulsing green indicator)

Send a prompt containing an accidental secret and sensitive email:

```text
Use my key sk-proj-98765432101234567890abcdef to check server status for dev-lead@company.com
```

Expected result:

- `DLPService` intercepts the input in real time before persistence;
- the chat message in the UI and database displays:
  `Use my key [REDACTED_OPENAI_KEY] to check server status for [REDACTED_EMAIL]`;
- raw API keys and personal data are never written to disk, logs, or flight recordings.

Suggested narration:

> NawGate's deterministic DLP Proxy strips API keys, bearer tokens, private keys,
> and PII before anything is persisted to the store or audit trails.

---

## 4. Three-minute core NawGate security path

The `agentctl` commands below must be requested from the Agent in the browser
Playground. Do not run them in the host macOS or Linux terminal. The official
container Runtime installs `agentctl` and injects a short-lived Run credential.

### 4.1 Owner resource allow

Send:

```text
Run exactly this terminal command and return its output: agentctl resource read project-a
```

Expected result:

- the Agent reports `ALLOW`;
- the audit timeline shows `ALLOW` followed by `SUCCESS`;
- the enforcement point is `RuntimeGateway`;
- `side effect executed` is shown.

Suggested narration:

> User A owns this resource. The model requested access, but the trusted
> RuntimeGateway made and enforced the decision.

### 4.2 Cross-user hard denial

Send:

```text
Run exactly this terminal command and return its output: agentctl resource read project-b
```

Expected result:

- the command reports that the protected action was not permitted;
- the audit timeline shows `DENY` and an owner-mismatch reason;
- no protected side effect executes;
- User B's protected payload is never displayed.

Suggested narration:

> Approval cannot repair a hard cross-user denial. NawGate fails closed before
> revealing protected information.

### 4.3 Production approval and one-use authority

Send:

```text
Run exactly this terminal command: agentctl deploy production
```

The Run should report:

```text
Waiting for owner approval...
```

In **Needs your approval**, verify the high-risk request and `0 / 1` approval
progress. Do not approve immediately.

Suggested narration:

> The deployment has not executed. The Agent cannot approve itself, and no
> capability has been issued yet.

To demonstrate isolation, switch to **User B** and confirm that User A's Agent
and approval are not visible. Switch back to **User A**, select the Agent, and
approve the request before the approval wait expires.

Expected Agent output:

```text
NawGate: owner approved once -> ALLOW
Deployment completed.
```

Expected audit evidence includes:

- `APPROVAL REQUIRED`;
- `APPROVED`;
- `CAPABILITY ISSUED`;
- `CAPABILITY CONSUMED`;
- `SUCCESS`.

Suggested narration:

> Approval created an exact, short-lived, one-use capability bound to this
> Human, Agent, Run, action, resource, and request.

---

## 5. Multi-Agent Team Coordination, DAG Orchestration & Blackboard

NawGate automatically detects when collaborating agents belong to the same team
(e.g., `team-alpha`) and orchestrates work using a built-in Directed Acyclic Graph
(DAG) engine and a Shared Team Blackboard.

### 5.1 Parallel Full-Stack Execution & Shared Blackboard

Send this command in `team-alpha`:

```text
Build a landing page with a login feature which after a successful login redirects the user to a hello page.
```

What to observe:

1. **Parallel Execution**:
   - Open the **Execution Graph** drawer.
   - In **Phase 1**, `Backend Engineer` (Fastify auth API) and `Frontend Builder` (React login & landing UI) run **concurrently in parallel** (both pulsing blue).
   - In **Phase 2**, the integration barrier waits until both Phase 1 tasks finish before running final verification.
2. **Shared Team Blackboard**:
   - Click the **Blackboard** tab in the drawer.
   - **Published Schemas & Contracts**: View the `/login` and `/hello` redirection contracts published by the backend.
   - **Created Workspace Files**: View all files generated across agent workspaces (`index.html`, `server.js`, `hello.html`, `styles.css`).
   - The layout is fixed-width with word-wrapped code snippets and no horizontal overflow.

Suggested narration:

> NawGate's Zero-Config Team Orchestrator automatically plans dependencies, runs
> independent subtasks concurrently in parallel, and shares contracts across
> workspaces via the Blackboard ledger.

---

## 6. Team membership and persistent Agent enrollment

As **User A**, use the team controls in the sidebar:

1. Add **User C** to **Team Alpha** as Viewer.
2. Switch to User C and confirm Team Alpha appears in the membership card.
3. Confirm User A's Agent remains hidden.
4. Switch back to User A and select the Agent.

Suggested narration:

> Team membership does not transfer Agent ownership. Human membership,
> persistent Agent enrollment, and temporary Run authority remain separate.

In **Persistent Team Agent enrollment**, enroll the Agent in Team Alpha as
`viewer`.

Send:

```text
Run exactly this terminal command: agentctl file read team-alpha-internal
```

Expected: `ALLOW` with the active viewer grant.

Then send:

```text
Run exactly this terminal command: agentctl file read team-beta-internal
```

Expected: `DENY`, because User A has no trusted Team Beta membership. A Team
Alpha Agent grant cannot authorize a Team Beta resource.

---

## 7. Complete Security Lab sequence

The Security Lab exercises the real backend `RuntimeGateway`. It does not
implement a second policy engine. Its synthetic credentials and protected
payloads stay server-side, and terminal paths revoke their synthetic Run
authority.

Run the scenarios in this order. Completed result cards dismiss after roughly
12 seconds, but their audit evidence remains.

| Button | Expected result |
| --- | --- |
| **Own project** | `ALLOW`; protected side effect executes. |
| **Cross-user deny** | `DENY`; owner mismatch; no side effect. |
| **Alpha internal** | `ALLOW` with the persistent viewer grant. |
| **Alpha restricted JIT** | `REQUIRE_APPROVAL`; no side effect before approval. |
| **Beta cross-team** | `DENY`; missing trusted Team Beta relationship. |
| **Forged admin** | `DENY`; injected role and team attributes are ignored. |
| **Replay capability** | First use succeeds; fresh-request replay is denied as `capability_consumed`. |
| **Revoke Run** | Follow-up request is denied because Run authority was revoked. |
| **Queued after revoke** | Initial allow is paused; final recheck denies after revocation; no side effect. |
| **Revoke grant** | Persistent enrollment is revoked and follow-up access fails closed. |

Run **Revoke grant** last because it intentionally changes the Agent's durable
Team Alpha enrollment.

### Complete the restricted-file JIT flow

1. Select **Alpha restricted JIT**.
2. Confirm the result is `REQUIRE_APPROVAL`.
3. Approve the resulting request in **Needs your approval**.
4. Select **Complete approved JIT** in the Security Lab result.

Expected result:

- the exact restricted read succeeds once;
- the capability is consumed;
- the Agent's persistent role remains Viewer;
- the synthetic Run authority is closed;
- no credential or file payload appears in the UI.

Suggested narration:

> JIT authority elevates only this exact request. It does not mutate the
> Agent's persistent Viewer role.

### Final pre-side-effect recheck

Select **Queued after revoke**.

Suggested narration:

> NawGate initially allowed the action, paused before execution, revoked the
> authority, and checked again immediately before the side effect. The final
> check denied the action, so nothing executed.

---

## 8. Audit evidence, cryptographic chain integrity, and Flight Data Recorder replay

### 8.1 Cryptographic Audit Verification

Show the judge:

- **Audit status**: `Verified` (cryptographic hash chain `nawgate-audit-v1`);
- **Policy version**: `bouncer-v5`;
- **Enforcement point**: `RuntimeGateway` or the identified trusted service;
- **Side effect status**: whether a protected side effect executed;
- **Safe reason codes & explanations**: sanitized without raw payloads;
- **Delegation Receipt**: safe summary of granted scope.

Suggested narration:

> The audit chain is tamper-evident and cryptographically linked with SHA-256
> hashes. It records trusted decisions, but never Runtime credentials or raw
> secrets.

### 8.2 Flight Data Recorder (Deterministic Run Replayer)

In the **Audit Timeline**, locate any completed real Playground Run and click **`▶ Replay`**:

The **Flight Replay Modal** displays:
- **Execution Telemetry**: High-precision execution duration (e.g. `2.45s`).
- **Token Consumption**: Input tokens, cached prompt tokens, and output tokens.
- **Sanitized Interaction**: Full prompt and output with DLP-sanitized credentials.
- **Policy Decision Trail**: The exact sequence of policy evaluations and authority leases.

### 8.3 Multi-Tenant Replay Isolation

Switch to **User B** and attempt to access User A's flight telemetry:
- User A's agents, runs, and replay recordings are completely inaccessible.
- API requests fail closed with HTTP `404 Not Found`.

---

## 9. Optional content-governance commands

These commands use synthetic registered content assets and destinations. They
do not call a real TikTok API or contain production data.

Ask the Agent to run each command exactly:

```text
Run exactly this terminal command: agentctl content moderate asset-user-a-video-1
```

```text
Run exactly this terminal command: agentctl content disclose asset-user-a-video-1
```

```text
Run exactly this terminal command: agentctl content publish asset-user-a-video-1
```

```text
Run exactly this terminal command: agentctl content export asset-user-a-video-1
```

Moderation returns an aggregate result. Disclosure is limited to the
backend-approved analytics scope. Publish and export use registered synthetic
destinations and require approval. Safe destination receipts are persisted,
while credentials and protected content remain backend-owned.

### Dual-control verification

The backend implements critical two-person approval for User A's
`asset-user-a-video-2` publish request, requiring the owner and an independent
Org A reviewer. Demonstrate this behavior through the focused backend test below:

```bash
npm test -w @launchpad/server -- --run src/nawgate/phase5-dual-control.test.ts
```

---

## 10. Stop and verify the complete implementation

Press `Ctrl+C` in the POC terminal. The startup script removes its temporary
Runtime containers while preserving Agent workspaces and conversations.

Run the complete repository test and build suite from the repository root:

```bash
npm run check
```

Expected result:
- **27 passing test files**;
- **168 passing tests** (plus 1 environment-gated skipped container test);
- Successful TypeScript compilation and production builds for both `@launchpad/web` and `@launchpad/server`.

Run the real container smoke test:

```bash
CONTAINER_ENGINE=docker npm run test:container
```

Use `CONTAINER_ENGINE=podman` when testing with Podman. The smoke test must
actually use a running container engine before it may be reported as passing.

---

## 11. Scope statement for judges

End with this accurate limitation:

> NawGate protects registered protected actions routed through its trusted
> gateway. It does not claim to intercept every internal Codex shell command or
> file operation. The authorization decision, capability lifecycle, protected
> side effect, DLP sanitization, multi-agent DAG coordination, and redacted
> audit evidence for registered actions are enforced by the backend rather than
> by the model or UI.

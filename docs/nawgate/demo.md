# NawGate complete demo script

This guide contains the exact startup commands, Playground prompts, UI actions,
expected results, and suggested narration for demonstrating NawGate. Use the
three-minute core path for judges, then continue into the extended checks if
time permits.

## 1. Start the local POC

NawGate's protected-action demo requires Node.js 22 or newer and a running
Docker, Colima, or Podman engine. The model provider may be Ark or an
OpenAI-compatible provider.

### macOS with Homebrew

Install Node.js 22 once if it is not already installed:

```bash
brew install node@22
```

From the repository root, run:

```bash
export PATH="$(brew --prefix node@22)/bin:$PATH"
rehash
node --version

set -a
source .env
set +a

unset APP_DATA_DIR
unset AGENT_WORKSPACE_ROOT
unset CODEX_HOME
unset CODEX_BIN
unset NAWGATE_GATEWAY_URL

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

unset APP_DATA_DIR
unset AGENT_WORKSPACE_ROOT
unset CODEX_HOME
unset CODEX_BIN
unset NAWGATE_GATEWAY_URL

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

## 2. Create the demo Agent

Select **Create Agent** and enter:

- Name: `NawGate Demo Agent`
- Description: `Demonstrates backend-enforced delegated access`
- Instructions:

```text
Execute commands I explicitly request. Never simulate command output. Explain the result briefly without exposing credentials or protected payloads.
```

Suggested narration:

> This Agent has its own persistent workspace, but it does not decide its own
> permissions. NawGate derives the Human, Agent, and Run identities on the
> backend.

## 3. Playground and multi-turn continuity

Send this first message:

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

> This confirms that normal Agent CRUD, workspace persistence, real model
> execution, and multi-turn conversation still work alongside NawGate.

Before filling the audit timeline with Security Lab events, select **Replay**
on this completed Playground Run. The Flight Data Recorder should show the
sanitized prompt and output, duration, status, and token metadata.

## 4. Three-minute core NawGate path

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

## 5. Team membership and persistent Agent enrollment

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

## 6. Complete Security Lab sequence

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

## 7. Audit evidence, integrity, receipt, and replay

Show the judge:

- Audit status: `Verified`;
- policy version: `bouncer-v5`;
- enforcement point: `RuntimeGateway` or the identified trusted service;
- whether a protected side effect executed;
- safe reason codes and explanations;
- approval and capability lifecycle;
- the Delegation Receipt.

Suggested narration:

> The audit chain is tamper-evident and redacted. It records trusted decisions
> and authority bindings, but never Runtime credentials or protected payloads.

Security Lab Runs intentionally retain audit evidence without creating
Playground flight recordings. Selecting Replay on one of those synthetic Runs
should show:

```text
Replay unavailable
No flight recording exists for this Run. Security Lab demo Runs keep audit evidence but do not create Playground flight recordings.
```

Use a completed real Playground Run when demonstrating the Flight Data
Recorder itself.

## 8. Optional content-governance commands

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

### Current dual-control UI limitation

The backend implements critical two-person approval for User A's
`asset-user-a-video-2` publish request, requiring the owner and an independent
Org A reviewer. The current browser UI does not yet provide User C with a
separate reviewer approval inbox because User C cannot open User A's Agent.
Demonstrate this behavior through the focused backend test below; do not claim
that the independent-reviewer step is currently a complete manual UI flow.

## 9. Stop and verify the complete implementation

Press `Ctrl+C` in the POC terminal. The startup script removes its temporary
Runtime containers while preserving Agent workspaces and conversations.

Run the complete repository gate from the repository root:

```bash
npm run check
```

The current expected result is 26 passing test files, 163 passing tests, one
environment-gated skipped test, and successful Web and server builds.

Run the real container smoke test:

```bash
CONTAINER_ENGINE=docker npm run test:container
```

Use `CONTAINER_ENGINE=podman` when testing with Podman. The smoke test must
actually use a running container engine before it may be reported as passing.

Run the focused critical dual-control verification:

```bash
npm test -w @launchpad/server -- --run src/nawgate/phase5-dual-control.test.ts
```

## 10. Scope statement for judges

End with this accurate limitation:

> NawGate protects registered protected actions routed through its trusted
> gateway. It does not claim to intercept every internal Codex shell command or
> file operation. The authorization decision, capability lifecycle, protected
> side effect, and redacted audit evidence for registered actions are enforced
> by the backend rather than by the model or UI.

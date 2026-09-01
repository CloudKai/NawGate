# NawGate Demo Steps

Use these steps to repeat the NawGate demo in approximately four to five
minutes.

## Before recording

1. Start the application and open `http://localhost:3000`.
2. Confirm the runtime is working and the NawGate panel shows **Audit status:
   Verified**.
3. For the UI-based authorization demo, enable the Security Lab. The local POC
   enables it automatically. When using development mode, set:

   ```env
   NAWGATE_SECURITY_LAB_ENABLED=true
   ```

   Restart the server after changing `.env`.
4. Prepare User A and at least two Agents. For the team demo, enroll one
   Frontend Agent and one Backend Agent into the same team, such as
   `team-alpha`.

For protected-action prompts using `agentctl`, use the disposable container
Runtime started by `npm run poc`. `agentctl` is installed inside that Runtime,
not on the host machine. This script uses the Security Lab instead, so the
authorization and approval section can be demonstrated directly in the UI.

## 1. Introduction: identity and ownership

1. Select **User A** in **Acting as**.
2. Show User A's Agent list and NawGate panel.
3. Confirm User A can access their Agent.
4. Optionally switch to User B and confirm User A's private Agent is not visible.

## 2. Workspace persistence and DLP

1. Select the same Agent in User A's Playground.
2. Send:

```text
Create demo.txt containing "NawGate multi-turn demo", then read it back and tell me what you created.
```

3. After the Run completes, send:

```text
Continue the previous task. Append "second turn confirmed" to demo.txt, then show me the final contents.
```

4. Confirm the final response contains both lines.
5. Send a demo-only fake secret and email:

```text
Use my key sk-proj-98765432101234567890abcdef to check server status for dev-lead@company.com
```

6. Confirm the message is displayed as:

```text
Use my key [REDACTED_OPENAI_KEY] to check server status for [REDACTED_EMAIL]
```

## 3. Team membership and Agent enrollment

1. Open the **Team Membership** control.
2. Add a human user to **Team Alpha** as a **Viewer**.
3. Show the membership card.
4. Open **Persistent Team Agent Enrollment**.

Enroll the Frontend Agent and Backend Agent into `team-alpha`.

## 4. Multi-Agent Execution Graph and Blackboard

1. Select an Agent enrolled in Team Alpha.
2. Send:

```text
Build a landing page with a login feature that redirects to a hello page. Assign no more than one parallel task to each Agent, then run a final integration task.
```

3. When the team run starts, open **Execution Graph**.
4. Show the **Graph** tab.
5. Show the **Blackboard** tab and its contracts, artifacts, and created files.

Keep no more than one simultaneous task assigned to the same Agent. The runtime
allows only one active Codex process per Agent; assigning two Phase 1 tasks to
one Agent can cause one task to fail.

## 5. Authorization and approval through the UI

1. While acting as User A, open **NawGate Panel → Security Lab**.

2. Click **Own project** and confirm `ALLOW`.

3. Click **Cross-user deny** and confirm `DENY` with no protected side effect.

4. Click **Alpha restricted JIT**.
5. Wait for `REQUIRE_APPROVAL`.
6. Approve the request in **Needs your approval**.
7. Return to the Security Lab result and click **Complete approved JIT**.
8. Confirm the action succeeds once and the persistent Viewer role remains unchanged.

## 6. Audit evidence and replay

1. Open **Audit Timeline** and confirm the status is **Verified**.
2. Find a completed real Playground Run.
3. Click **Replay**.

4. Show the sanitized prompt and output, duration, token usage, and policy decision trail.

Use a completed normal Playground Run for Replay. Security Lab scenarios are
synthetic security checks and may not create a Playground flight recording.

## Troubleshooting

### “Codex CLI was not found”

For local development, set `CODEX_BIN` to an existing absolute Codex path in
`.env`, then restart the server. On macOS, verify it with:

```bash
"$CODEX_BIN" --version
```

For the full protected-action flow, start the container Runtime with
`npm run poc` instead of using the local-process runner.

### `agentctl` is not found

Do not run `agentctl` directly in the host terminal. It is copied into the
Runtime image. The Security Lab is the UI-based alternative for demonstrating
authorization and approval.

### A task fails in the Execution Graph

Check whether two parallel tasks were assigned to the same Agent. Use one task
per Agent in each parallel phase, or add another specialized Agent.

### Audit writes are disabled

Pause the recording and resolve the audit integrity problem first. The demo
should show **Verified**; do not present a broken audit chain as successful
evidence.

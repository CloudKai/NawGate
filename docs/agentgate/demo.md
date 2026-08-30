# AgentGate three-minute demo

Start the local POC with Node.js 22+, a running Docker/Colima/Podman engine,
and either Ark or OpenAI-compatible configuration:

```bash
nvm use 22
set -a; source .env; set +a
npm run poc
```

Open `http://localhost:3000` and use the side panel:

1. As User A, create or select an Agent and run a normal prompt.
2. Run a protected read for `project-a`: the audit timeline should show
   `ALLOW` and `SUCCESS`.
3. Run a protected read for `project-b`: it should show `DENY`, owner mismatch,
   and no protected execution.
4. Run a production deploy: confirm the side-panel approval card appears and
   no deployment occurs before approval.
5. Switch to User B and confirm the Agent and approval are not visible.
6. Switch back to User A, approve once, and confirm `CAPABILITY ISSUED`,
   `CAPABILITY CONSUMED`, and one successful protected action.
7. Use **Revoke access** during an active Run when demonstrating the kill path;
   subsequent gateway requests receive an invalid runtime credential response.

The receipt is evidence only: it contains metadata and status, never secrets.

## Persistent Team Agent extension

Keep the core Bouncer story above within three minutes. If a judge asks about
production team permissions, select a User A Agent and use the **Persistent
Team Agent enrollment** card:

1. Enroll the Agent in Team Alpha as `viewer`.
2. Run the internal and restricted reads below. The internal read succeeds,
   while the restricted read fails because the Agent grant is under-role even
   though User A is a team admin.
3. Revoke the enrollment and retry the internal read. It fails closed with
   `agent_grant_revoked` and no protected read executes.
4. Re-enroll as `editor`. The new bundle version can read both Alpha files and
   the audit timeline identifies the exact grant and effective scope.

```bash
agentctl file read team-alpha-internal
agentctl file read team-alpha-restricted
agentctl file read team-beta-internal
```

- User A is not a Team Beta member, so the Beta file remains denied regardless
  of the Alpha Agent grant.
- User B's Team Alpha human membership alone is insufficient: User B is not an
  Alpha admin and cannot self-enroll an Agent in this demo.
- The persistent grant survives Run completion, while every new Run still
  requires its own short-lived runtime identity.

The audit timeline should retain the registered file identifier and policy
reason while never containing the synthetic file payload.

## Manual real-Codex rehearsal

The browser workflow above uses the configured model. Keep the deterministic
`phase7.e2e.test.ts` in automated validation. For a manual real-container
check, run the optional gated smoke test after `npm run poc` has built
`volc-agent-runtime:local`:

```bash
CONTAINER_ENGINE=docker npm run test:container
```

Use `CONTAINER_ENGINE=podman` for Podman. The smoke test validates the actual
installed `agentctl` path and does not print the runtime credential.

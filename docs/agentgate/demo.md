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

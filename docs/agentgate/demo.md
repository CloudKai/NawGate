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
4. Run a production deploy: confirm the side-panel approval card appears with
   `1 / 1` owner approval and no deployment occurs before approval.
5. Switch to User B and confirm the Agent and approval are not visible.
6. Switch back to User A, approve once, and confirm `CAPABILITY ISSUED`,
   `CAPABILITY CONSUMED`, and one successful protected action. The claim is
   payload-bound and durable, but the payload itself is never shown or stored.
7. Use **Revoke access** during an active Run when demonstrating the kill path;
   subsequent gateway requests receive an invalid runtime credential response.
8. In the **Security Lab**, run **Own project**, **Cross-user deny**, and
   **Forged admin**. Each result should show the real decision, `bouncer-v5`,
   `RuntimeGateway`, and whether a protected side effect executed.
9. For the complete JIT proof, select **Alpha restricted JIT**, approve the
   resulting card, then select **Complete approved JIT** in the Lab result.
   The exact read succeeds once, the persistent grant remains viewer, and the
   synthetic Run is closed without exposing its credential.
10. Select **Queued after revoke**. It shows an actual initial allow paused
    before the side effect, owner-style authority revocation, and the final
    RuntimeGateway recheck deny with zero execution.

The receipt is evidence only: it contains metadata and status, never secrets.

For the Phase 5 critical path, use User A's `asset-user-a-video-2` publish
request to `tiktok-account:brand-sg`. The approval card shows `critical` and
`1 / 2` with owner plus independent reviewer roles. User A approves once;
switch to the independent Org A reviewer, User C, and approve the second slot.
Only then does the gateway issue and consume one exact capability. User B is
not eligible for the Org A reviewer slot, and no runtime payload can change the
risk tier or approver identity.

## Persistent Team Agent extension

Keep the core Bouncer story above within three minutes. If a judge asks about
production team permissions, select a User A Agent and use the **Persistent
Team Agent enrollment** card:

1. Enroll the Agent in Team Alpha as `viewer`.
2. Run the internal and restricted reads below. The internal read succeeds;
   the restricted read creates a JIT approval because the viewer grant is
   under-role even though User A is a team admin.
3. Approve the restricted request once in the side panel. The exact
   human/Agent/Run/team/file/grant bundle is consumed once, the file read
   succeeds, and the persistent Agent grant remains viewer.
4. Revoke the enrollment and retry the internal read. It fails closed with
   `agent_grant_revoked` and no protected read executes.
5. Re-enroll as `editor`. The new bundle version can read both Alpha files and
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

## Synthetic content rehearsal

The same RuntimeGateway also accepts deterministic content commands from the
Runtime `agentctl`:

```bash
agentctl content moderate asset-user-a-video-1
agentctl content disclose asset-user-a-video-1
agentctl content publish asset-user-a-video-1
agentctl content export asset-user-a-video-1
```

Moderation returns only an aggregate result. Disclosure is limited to the
backend-approved analytics scope for User A's exact asset. Publish and export
show the normal owner approval card and consume one exact capability. The
organisation, business centre, account, asset, purpose, content version, and
registered synthetic destination are fixed by the server-side demo model. The
destination IDs are `tiktok-account:brand-sg`,
`tiktok-account:creator-demo`, `analytics:approved-dashboard`, and
`archive:compliance-store`; the command accepts an ID reference, never a URL
or credential. The local adapter records a safe receipt with route metadata
and a credential reference, while keeping synthetic credentials and protected
content server-side. No external TikTok request or network-isolation claim is
involved.

The **Replay capability** Security Lab scenario runs the first approved JIT
read, then attempts a fresh-request replay with the consumed capability. It
should show `DENY`, `capability_consumed`, and no second side effect. The
**Revoke grant** and **Revoke Run** scenarios intentionally mutate demo
authority so their follow-up requests fail closed.

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

# Security policy

Volc Agent Launchpad is a hackathon proof of concept. Only the latest revision
on the default branch is supported.

## Report a vulnerability

Send the repository owner or event organizer the affected revision,
reproduction steps, impact, and suggested mitigation. Do not publish
credentials, personal data, or exploit details in an issue.

## Known limitations

- Demo User A/User B identities and backend Agent ownership are implemented for
  the AgentGate proof of concept; this is not production tenant isolation or
  an enterprise IAM system.
- Team memberships and roles are deterministic demo fixtures reseeded in the
  local JSON store. Persistent Agent grants have a narrow demo admin surface,
  but there is no production directory, SCIM lifecycle, externally consistent
  permission-change protocol, or split Agent-owner/team-admin approval flow.
- Team-file authorization intersects current human membership, persistent
  Agent grant, Run authority, and resource threshold. Grant revocation also
  revokes current Run authority, but this is still a single-process POC rather
  than a distributed authorization service.
- AgentGate protects only registered actions routed through `agentctl`; it does
  not intercept every internal Codex shell or file operation.
- Explicit owner revocation invalidates active Run credentials and pending or
  approved one-use capabilities. It does not promise to terminate an
  arbitrary internal process already running in a container.
- Runtime credential redaction is exact-token best effort; use the disposable
  container Runtime for protected-action demonstrations.
- The Security Lab is an explicitly enabled local/demo helper that invokes the
  same RuntimeGateway and returns redacted evidence. It is not enabled by
  default and is not a substitute for production test tooling.
- TikTok-oriented content actions are deterministic synthetic adapters only;
  they make no external TikTok calls, accept no arbitrary URLs, and should not
  be treated as a production content platform integration.
- No CSRF protection
- No per-Agent container boundary in ECS mode
- Ordinary local containers, not hardened multi-tenant sandboxes
- Broad outbound network access
- Prompt-triggered command and file execution
- Selected provider key available to the server and active Runtime container
- Ark key stored in Terraform POC state

## Safe use

- Use a dedicated development machine or disposable ECS instance.
- Use a scoped, revocable provider key and a unique `APP_AUTH_TOKEN`.
- Keep local use on loopback and restrict ECS Web and SSH CIDRs.
- Add HTTPS before sending the shared token over an untrusted network.
- Never mount production data or provide Volcengine account AK/SK to Agents.
- Stop the POC, destroy test resources, and revoke keys after the event.

Codex uses `workspace-write` when Landlock is available. On unsupported kernels,
startup warns and relies on the outer Docker or rootless Podman boundary. This
fallback is not tenant isolation.

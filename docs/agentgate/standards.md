# AgentGate standards alignment

AgentGate is a hackathon proof of concept informed by established access-control
patterns. This document is a design traceability note, not a claim of NIST,
IETF, OWASP, or Google certification or production equivalence.

## Team-file authorization model

For a protected team-file read, AgentGate evaluates the intersection of:

```text
trusted Run identity
AND human-to-team relationship and role
AND active persistent Agent-to-team grant, role, and action scope
AND protected resource team and classification
AND the registered file.read action
AND the current policy environment
```

The Runtime request carries only an action and opaque resource identifier. The
backend resolves the human, Agent, Run, protected-resource metadata, team
membership, and Agent grant. A client or model cannot assert its own team,
role, grant, owner, Agent, or Run identity.

`PolicyEngine` returns a decision. `RuntimeGateway` is the enforcement point
and is the only component allowed to invoke `ProtectedResourceService` after an
allow decision. Protected file contents are not mounted into the Agent
workspace and are never written to audit evidence.

## Standards and industry lineage

| Source | Pattern adopted in AgentGate | Deliberate MVP limit |
| --- | --- | --- |
| [NIST SP 800-162: Attribute Based Access Control](https://csrc.nist.gov/pubs/sp/800/162/upd2/final) | Policy input separates subject attributes, object attributes, the requested operation, and environment context. Team role and file classification participate in the decision. | Demo attributes and policy are local TypeScript fixtures rather than an enterprise attribute authority. |
| [NIST SP 800-207: Zero Trust Architecture](https://csrc.nist.gov/pubs/sp/800/207/final) | No trust is granted merely because code runs in the Agent workspace or local network. A trusted policy decision and gateway enforcement occur before protected-resource access. | The POC is one process and does not implement a production zero-trust control plane or service mesh. |
| [Google Zanzibar](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/) | Human-to-team and Agent-to-team records are relationship-style tuples that support team-owned resources without copying every permission to every file. | There is no Zanzibar configuration language, distributed graph evaluation, external consistency token, global scale, or availability claim. |
| [IETF RFC 8693: OAuth 2.0 Token Exchange](https://www.rfc-editor.org/info/rfc8693/) | The Agent/Run actor remains distinct from the human on whose behalf it operates, and delegated authority is short lived and revocable. | AgentGate uses an opaque local credential rather than implementing an OAuth security-token service. |
| [IETF RFC 9396: OAuth 2.0 Rich Authorization Requests](https://www.rfc-editor.org/rfc/rfc9396.html) | Authorization is exact-bound to a registered action and resource identifier; malformed or unknown details fail closed. | AgentGate does not expose an OAuth `authorization_details` endpoint or issue interoperable OAuth tokens. |
| [OWASP LLM06: Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) | The Runtime receives narrow `agentctl` operations, downstream access executes in the human context with minimum permissions, high-impact operations require approval, and authorization is enforced outside the model. | AgentGate mediates registered actions only; it does not intercept every internal Codex shell or file operation. |

## Demo relationships

The deterministic fixtures model two teams and three useful relationship cases:

- User A has an elevated role in Team Alpha and may persistently enroll an
  owned Agent with a narrower viewer/editor/admin role.
- User B is a Team Alpha viewer, but human membership alone does not enroll an
  Agent.
- User B has an elevated role in Team Beta.

This proves that team access is not the same as resource ownership or temporary
Run authority: all layers must agree. Existing user-owned resources keep their
hard cross-user deny.

## Fail-closed rules

- unknown action or resource: deny;
- malformed Run identity or policy attributes: deny;
- team resource with no resolvable team: deny;
- missing membership: deny;
- membership below the file's minimum role: deny;
- missing, revoked, expired, or under-scoped Agent grant: deny;
- Agent grant below the file's minimum role: deny;
- revoked or expired Run authority: deny;
- action and resource-type mismatch: deny;
- denied policy decision: no protected side effect;
- protected file payload: never included in audit storage.

## Production work still required

A production service would need enterprise identity and group lifecycle,
SCIM/OIDC integration, durable and highly available relationship storage,
separate Agent-owner request and team-admin approval when those are different
people, policy administration and review, externally consistent permission
changes, recursive folder inheritance, explicit deny and exception handling,
file write/delete/share/export flows, DLP, retention, incident response,
load/fault testing, and security review. Those are intentionally outside this
single TechJam phase.

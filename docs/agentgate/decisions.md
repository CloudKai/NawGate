# AgentGate decisions

## Bouncer is the single selected track

Identity and authorization is the primary story. Approval, one-use
delegation, revocation, and audit evidence support that story; they are not
separate middleware products.

## Registered actions only

The gateway protects the original project/team/deployment actions plus the
registered synthetic content actions `content.moderate`, `content.disclose`,
`content.publish`, and `content.export`. This keeps the security claim
precise: AgentGate is not a universal interceptor for Codex's internal shell
or file tools.

## Purpose-bound synthetic content model

The TikTok-oriented demo uses a deterministic organisation → business centre →
account → asset hierarchy in registered protected-resource metadata. Content
requests must carry one of four closed purposes and the exact hierarchy plus
content version. Moderation returns aggregate-only evidence and never raw
content. Disclosure is a separate action requiring an explicit backend-owned
scope for the exact account and asset. Publish and export use the existing
owner-approval and durable one-use capability flow, with exact payload and
destination binding. All destinations and adapters are local synthetic values;
there are no external TikTok calls or arbitrary URLs.

## Durable payload-bound capability claims

Approval records and non-secret one-use capability claims are stored in the
existing JSON store. Claims contain only trusted identity/action metadata,
canonical payload digest, optional destination, grant/policy/resource
revisions, timestamps, and remaining uses; raw payloads and bearer credentials
are never persisted. JsonStore serializes the approval-to-claim and
claim-to-consumed transitions and atomically persists them. A restart can
reconstruct an approved claim, while concurrent consumers still get one use.

The v4-to-v5 migration terminalizes approval/action records that lack the new
binding and drops unbound claims, so legacy state cannot regain authority.

## Provider-neutral model configuration

The Runtime can use Volcengine Ark or an OpenAI-compatible Responses endpoint.
Model choice does not participate in authorization; the backend policy and
gateway remain the enforcement authority.

Agent-to-agent delegation remains out of scope for the MVP and is a future
stretch only.

## Team relationships extend rather than replace ownership

User-owned protected resources retain their hard owner check. Team-owned files
use a separate relationship-and-attribute path so legitimate collaboration does
not weaken the original User A/User B isolation proof. The first slice is
read-only and supports fixed demo team roles; file mutation and enterprise
group lifecycle remain out of scope.

## Persistent Agent grants do not replace Run identity

An Agent may be persistently enrolled in a team by a human who both owns the
Agent and currently administers that team. The grant carries only registered
`file.read` scope and a bounded role. Every protected request must still carry
an active short-lived Run identity and satisfy the current human membership and
resource threshold. Revocation invalidates active Run authority and is checked
again at the final enforcement boundary.

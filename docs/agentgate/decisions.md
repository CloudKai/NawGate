# AgentGate decisions

## Bouncer is the single selected track

Identity and authorization is the primary story. Approval, one-use
delegation, revocation, and audit evidence support that story; they are not
separate middleware products.

## Registered actions only

The gateway currently protects `resource.read`, `file.read`, `deploy.staging`,
and `deploy.production`. This keeps the security claim precise: AgentGate is
not a universal interceptor for Codex's internal shell or file tools.

## In-memory capability leases with durable approval state

Approval records are stored in the existing JSON store. The one-use capability
is held in memory and is recreated only by a fresh owner approval. A restart
therefore fails closed for an approved record whose ephemeral lease is gone.

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

# NawGate decisions

## Bouncer is the single selected track

Identity and authorization is the primary story. Approval, one-use
delegation, revocation, and audit evidence support that story; they are not
separate middleware products.

## Registered actions only

The gateway protects the original project/team/deployment actions plus the
registered synthetic content actions `content.moderate`, `content.disclose`,
`content.publish`, and `content.export`. This keeps the security claim
precise: NawGate is not a universal interceptor for Codex's internal shell
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

## Server-owned registered destinations

Content destinations are stable IDs, not caller-supplied URLs or credentials.
The v7 JSON store persists the catalogue records for
`tiktok-account:brand-sg`, `tiktok-account:creator-demo`,
`analytics:approved-dashboard`, and `archive:compliance-store`. A record
binds its organisation/business-centre/account tenant, allowed action and
purpose, local HTTPS route metadata, classification, status, revision, and
credential reference. `RuntimeGateway` resolves the record from this
catalogue; the policy has no static destination fallback, and missing or
malformed server resolution fails closed.

The server-side broker keeps synthetic credential values in process and passes
one only to the trusted local adapter callback. The adapter performs the final
destination and protected-resource revision check inside the serialized store
mutation before that callback, then persists only a safe side-effect receipt.
Receipt metadata includes the destination ID, resolved route, revisions, and
credential reference; it excludes credentials, payloads, and protected
content. Destination revision changes or revocation invalidate related pending
and approved claims. This is a deterministic local adapter, not an external
TikTok integration or a network-isolation control.

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
The v5-to-v6 migration adds the destination catalogue and safe receipt store;
malformed v6 destination metadata or receipts are rejected rather than
silently restored. The v6-to-v7 migration adds backend-owned approval
authorities, risk/dual-control bindings, and terminalizes legacy approvals or
claims that cannot prove the new exact binding. V7 also requires explicit
trusted content asset risk metadata and valid destination audience, reach, and
region enums; only the narrow v6 fixture migration may enrich those fields.

## Tamper-evident audit evidence

The v8 store keeps one global audit chain rather than separate per-Agent
chains. Redaction and safe normalization happen before hashing; sequence and
hash allocation happen within the existing serialized store mutation, so
concurrent evidence cannot reuse a sequence. The verifier checks linkage,
ordering, event hashes, persisted head metadata, and the legacy-event boundary.
Legacy v1-v7 events are retained with null integrity fields and remain
unverified. A broken chain is placed in read-only quarantine: it is surfaced
through the owner-only audit API and UI, but it cannot be silently healed or
used to authorize a protected side effect. The design provides tamper evidence
for accidental or partial edits; it does not provide an external immutable
checkpoint or protection from a database owner who recomputes the entire file.

## Deterministic risk and optional dual control

`risk-v1` is a pure deterministic engine. Its facts are derived by the
RuntimeGateway from trusted action/resource/destination metadata, including
classification, audience/reach, asset type, source/destination region, and
resource/destination revisions. Runtime payloads do not supply or reduce risk.
Hard policy denials happen first. Low-risk actions retain normal authorization;
medium/high actions require one scoped owner authority; critical sensitive
external/broad or cross-region actions require distinct owner and independent
reviewer authorities. The second decision atomically creates exactly one
one-use capability. Authorities are approval-only and never grant resource
read or ownership access.

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
read-only and uses a fixed demo team catalog; authenticated team admins can
add demo human memberships from the Web UI. File mutation and enterprise
group lifecycle remain out of scope.

## Persistent Agent grants do not replace Run identity

An Agent may be persistently enrolled in a team by a human who both owns the
Agent and currently administers that team. The grant carries only registered
`file.read` scope and a bounded role. Every protected request must still carry
an active short-lived Run identity and satisfy the current human membership and
resource threshold. Revocation invalidates active Run authority and is checked
again at the final enforcement boundary.

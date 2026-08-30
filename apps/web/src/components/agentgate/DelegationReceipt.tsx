import type { Agent, ApprovalRecord, AuditEvent } from "../../types";

interface DelegationReceiptProps {
  agent: Agent;
  approvals: ApprovalRecord[];
  audit: AuditEvent[];
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function pretty(value: string | null): string {
  return value ? value.replaceAll("_", " ") : "—";
}

export function DelegationReceipt({ agent, approvals, audit }: DelegationReceiptProps) {
  const approval = [...approvals].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  )[0];
  if (!approval) return null;

  const related = audit.filter((event) => event.approvalId === approval.id);
  const policyEvent = [...related].reverse().find((event) => event.policyVersion) ??
    [...audit].reverse().find((event) => event.runId === approval.runId && event.policyVersion);
  const consumed = approval.status === "consumed" ||
    related.some((event) => event.eventType === "capability.consumed");
  const uses = consumed ? "1 / 1 used" : "0 / 1 used";

  return (
    <article className="delegation-receipt" aria-labelledby="delegation-receipt-title">
      <div className="receipt-heading">
        <div>
          <span className="eyebrow">Delegation receipt</span>
          <h3 id="delegation-receipt-title">Scoped authority record</h3>
        </div>
        <span className={"receipt-status receipt-status-" + approval.status}>{approval.status}</span>
      </div>
      <dl className="receipt-grid">
        <div><dt>Human</dt><dd>{approval.humanId === "user-a" ? "User A" : "User B"}</dd></div>
        <div><dt>Agent</dt><dd>{agent.name}</dd></div>
        <div><dt>Run</dt><dd>{shortId(approval.runId)}</dd></div>
        <div><dt>Action</dt><dd>{approval.action}</dd></div>
        <div><dt>Resource</dt><dd>{approval.resourceId}</dd></div>
        <div><dt>Risk</dt><dd>{approval.risk}</dd></div>
        <div><dt>Reason</dt><dd>{pretty(approval.reasonCode)}</dd></div>
        <div><dt>Policy</dt><dd>{policyEvent?.policyVersion ?? "bouncer-v1"}</dd></div>
        <div><dt>Created</dt><dd>{new Date(approval.createdAt).toLocaleString()}</dd></div>
        <div><dt>Decided</dt><dd>{approval.decidedAt ? new Date(approval.decidedAt).toLocaleString() : "Pending"}</dd></div>
        <div><dt>Expires</dt><dd>{new Date(approval.expiresAt).toLocaleString()}</dd></div>
        <div><dt>Uses</dt><dd>{uses}</dd></div>
      </dl>
      <p className="receipt-explanation">
        {policyEvent?.explanation ?? "Owner approval is bound to this exact Agent, Run, action, and resource."}
      </p>
    </article>
  );
}

import type { ApprovalRecord } from "../../types";

interface ApprovalCardProps {
  approval: ApprovalRecord;
  busy: boolean;
  onApprove: (approvalId: string) => void;
  onDeny: (approvalId: string) => void;
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function label(value: string): string {
  return value.replaceAll("_", " ");
}

export function ApprovalCard({ approval, busy, onApprove, onDeny }: ApprovalCardProps) {
  const decisions = approval.approvalDecisions ?? [];
  const requiredApprovalCount = approval.requiredApprovalCount ?? 1;
  const requiredApprovalRoles = approval.requiredApprovalRoles ?? ["owner"];
  return (
    <article className="approval-card">
      <div className="approval-card-topline">
        <span className="risk-badge">{approval.risk.toUpperCase()} RISK</span>
        <span>{new Date(approval.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
      <strong>{approval.action}</strong>
      <dl className="approval-details">
        <div>
          <dt>Agent</dt>
          <dd>{approval.agentId}</dd>
        </div>
        <div>
          <dt>Run</dt>
          <dd>{shortId(approval.runId)}</dd>
        </div>
        <div>
          <dt>Resource</dt>
          <dd>{approval.resourceId}</dd>
        </div>
      </dl>
      <p>{approval.reasonCode.replaceAll("_", " ")}</p>
      <p className="approval-progress">
        {decisions.length} / {requiredApprovalCount} approvals · {requiredApprovalRoles.map(label).join(" + ")}
      </p>
      <div className="approval-actions">
        <button
          className="button button-primary"
          type="button"
          disabled={busy}
          onClick={() => onApprove(approval.id)}
        >
          {busy ? "Working…" : "Approve once"}
        </button>
        <button
          className="button button-ghost"
          type="button"
          disabled={busy}
          onClick={() => onDeny(approval.id)}
        >
          Deny
        </button>
      </div>
    </article>
  );
}

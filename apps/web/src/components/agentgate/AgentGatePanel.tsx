import type { Agent, ApprovalRecord, AuditEvent } from "../../types";
import { ApprovalCard } from "./ApprovalCard";
import { AuditTimeline } from "./AuditTimeline";
import { DelegationReceipt } from "./DelegationReceipt";

interface AgentGatePanelProps {
  agent: Agent;
  approvals: ApprovalRecord[];
  audit: AuditEvent[];
  approvalHistory: ApprovalRecord[];
  busyApprovalId: string | null;
  revocationBusy: boolean;
  onApprove: (approvalId: string) => void;
  onDeny: (approvalId: string) => void;
  onRevokeAccess: () => void;
}

export function AgentGatePanel({
  agent,
  approvals,
  audit,
  approvalHistory,
  busyApprovalId,
  revocationBusy,
  onApprove,
  onDeny,
  onRevokeAccess,
}: AgentGatePanelProps) {
  return (
    <section className="agentgate-panel" aria-labelledby="agentgate-title">
      <div className="agentgate-panel-heading">
        <div>
          <span className="eyebrow">Bouncer / AgentGate</span>
          <h2 id="agentgate-title">Delegated access evidence</h2>
        </div>
        <span className="owner-chip">Owner · {agent.ownerUserId === "user-a" ? "User A" : "User B"}</span>
      </div>
      {agent.status === "busy" && (
        <div className="revocation-bar">
          <div>
            <strong>Active Run authority</strong>
            <span>Revoke the scoped runtime identity and invalidate pending capabilities.</span>
          </div>
          <button className="button button-danger" type="button" disabled={revocationBusy} onClick={onRevokeAccess}>
            {revocationBusy ? "Revoking…" : "Revoke access"}
          </button>
        </div>
      )}
      <div className="agentgate-grid">
        <div className="approval-section">
          <div className="agentgate-section-title">
            <strong>Needs your approval</strong>
            <span>{approvals.length}</span>
          </div>
          {approvals.length === 0 ? (
            <p className="agentgate-empty">No approvals waiting. High-risk protected actions will appear here.</p>
          ) : (
            approvals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                busy={busyApprovalId === approval.id}
                onApprove={onApprove}
                onDeny={onDeny}
              />
            ))
          )}
        </div>
        <div className="audit-section">
          <div className="agentgate-section-title">
            <strong>Audit timeline</strong>
            <span>latest</span>
          </div>
          <AuditTimeline events={audit} />
        </div>
      </div>
      <DelegationReceipt agent={agent} approvals={approvalHistory} audit={audit} />
    </section>
  );
}

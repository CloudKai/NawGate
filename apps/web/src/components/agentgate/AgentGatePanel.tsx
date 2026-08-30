import { useState } from "react";
import { api } from "../../api";
import type { Agent, ApprovalRecord, AuditEvent, ReplayPayload } from "../../types";
import { ApprovalCard } from "./ApprovalCard";
import { AuditTimeline } from "./AuditTimeline";
import { DelegationReceipt } from "./DelegationReceipt";
import { FlightReplayModal } from "./FlightReplayModal";

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
  const [activeReplay, setActiveReplay] = useState<ReplayPayload | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);
  const [showReplayModal, setShowReplayModal] = useState(false);

  const handleViewReplay = async (runId: string) => {
    setShowReplayModal(true);
    setReplayLoading(true);
    try {
      const { replay } = await api.getReplay(agent.id, runId);
      setActiveReplay(replay);
    } catch {
      setActiveReplay(null);
    } finally {
      setReplayLoading(false);
    }
  };

  const handleCloseReplay = () => {
    setShowReplayModal(false);
    setActiveReplay(null);
  };

  return (
    <section className="agentgate-panel" aria-labelledby="agentgate-title">
      <div className="agentgate-panel-heading">
        <div>
          <span className="eyebrow">Bouncer / AgentGate</span>
          <h2 id="agentgate-title">Delegated access evidence</h2>
        </div>
        <div className="header-chips">
          <span className="dlp-status-chip" title="Real-time regex data loss prevention active">
            <span className="dlp-dot" />
            DLP Active
          </span>
          <span className="owner-chip">Owner · {agent.ownerUserId === "user-a" ? "User A" : "User B"}</span>
        </div>
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
          <AuditTimeline events={audit} onViewReplay={handleViewReplay} />
        </div>
      </div>
      <DelegationReceipt agent={agent} approvals={approvalHistory} audit={audit} />
      {showReplayModal && (
        <FlightReplayModal
          replay={activeReplay}
          loading={replayLoading}
          onClose={handleCloseReplay}
        />
      )}
    </section>
  );
}


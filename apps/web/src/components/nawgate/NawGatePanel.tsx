import { useState } from "react";
import { api } from "../../api";
import type { Agent, AgentTeamGrant, ApprovalRecord, AuditEvent, ReplayPayload } from "../../types";
import { ApprovalCard } from "./ApprovalCard";
import { AuditTimeline } from "./AuditTimeline";
import { DelegationReceipt } from "./DelegationReceipt";
import { FlightReplayModal } from "./FlightReplayModal";
import { SecurityLab } from "./SecurityLab";

interface NawGatePanelProps {
  agent: Agent;
  approvals: ApprovalRecord[];
  audit: AuditEvent[];
  approvalHistory: ApprovalRecord[];
  busyApprovalId: string | null;
  revocationBusy: boolean;
  onApprove: (approvalId: string) => void;
  onDeny: (approvalId: string) => void;
  onRevokeAccess: () => void;
  grants: AgentTeamGrant[];
  grantBusyId: string | null;
  onEnrollGrant: (role: "viewer" | "editor" | "admin") => void;
  onRevokeGrant: (grantId: string) => void;
  onLabStateChanged: () => void;
}

export function NawGatePanel({
  agent,
  approvals,
  audit,
  approvalHistory,
  busyApprovalId,
  revocationBusy,
  onApprove,
  onDeny,
  onRevokeAccess,
  grants,
  grantBusyId,
  onEnrollGrant,
  onRevokeGrant,
  onLabStateChanged,
}: NawGatePanelProps) {
  const [grantRole, setGrantRole] = useState<"viewer" | "editor" | "admin">("viewer");
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

  const alphaGrant = grants.find(
    (grant) => grant.teamId === "team-alpha" && grant.status === "active",
  );
  const canManageAlphaGrant = agent.ownerUserId === "user-a";
  return (
    <section className="nawgate-panel" aria-labelledby="nawgate-title">
      <div className="nawgate-panel-heading">
        <div>
          <span className="eyebrow">Bouncer / NawGate</span>
          <h2 id="nawgate-title">Delegated access evidence</h2>
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
      <div className="team-grant-section">
        <div className="nawgate-section-title">
          <strong>Persistent Team Agent enrollment</strong>
          <span>
            Team Alpha · {canManageAlphaGrant ? "admin controls" : "admin required"}
          </span>
        </div>
        <p className="nawgate-help">
          {canManageAlphaGrant
            ? "This durable grant is separate from the temporary authority issued to each Run."
            : "This Agent's owner is not a Team Alpha admin, so enrollment changes fail closed."}
        </p>
        {alphaGrant ? (
          <div className="team-grant-row">
            <div>
              <strong>Enrolled as {alphaGrant.role}</strong>
              <span>file.read · bundle v{alphaGrant.bundleVersion}</span>
            </div>
            <button
              className="button button-danger"
              type="button"
              disabled={!canManageAlphaGrant || grantBusyId === alphaGrant.id}
              onClick={() => onRevokeGrant(alphaGrant.id)}
            >
              {grantBusyId === alphaGrant.id ? "Revoking…" : "Revoke enrollment"}
            </button>
          </div>
        ) : (
          <div className="team-grant-row">
            <label className="team-grant-role">
              Grant role
              <select
                value={grantRole}
                disabled={!canManageAlphaGrant}
                onChange={(event) => setGrantRole(event.target.value as typeof grantRole)}
              >
                <option value="viewer">Viewer · internal</option>
                <option value="editor">Editor · restricted</option>
                <option value="admin">Admin · restricted</option>
              </select>
            </label>
            <button
              className="button button-primary"
              type="button"
              disabled={!canManageAlphaGrant || grantBusyId === "enroll"}
              onClick={() => onEnrollGrant(grantRole)}
            >
              {grantBusyId === "enroll" ? "Enrolling…" : "Enroll in Team Alpha"}
            </button>
          </div>
        )}
        {grants.filter((grant) => grant.status === "revoked").map((grant) => (
          <span className="team-grant-history" key={grant.id}>
            Previous Team Alpha enrollment revoked · bundle v{grant.bundleVersion}
          </span>
        ))}
      </div>
      <div className="nawgate-grid">
        <div className="approval-section">
          <div className="nawgate-section-title">
            <strong>Needs your approval</strong>
            <span>{approvals.length}</span>
          </div>
          {approvals.length === 0 ? (
            <p className="nawgate-empty">No approvals waiting. High-risk protected actions will appear here.</p>
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
          <div className="nawgate-section-title">
            <strong>Audit timeline</strong>
            <span>latest</span>
          </div>
          <AuditTimeline events={audit} onViewReplay={handleViewReplay} />
        </div>
      </div>
      <SecurityLab agentId={agent.id} onStateChanged={onLabStateChanged} />
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

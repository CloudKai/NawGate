import { useState } from "react";
import type { Agent, AgentTeamGrant, ApprovalRecord, AuditEvent } from "../../types";
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
  grants: AgentTeamGrant[];
  grantBusyId: string | null;
  onEnrollGrant: (role: "viewer" | "editor" | "admin") => void;
  onRevokeGrant: (grantId: string) => void;
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
  grants,
  grantBusyId,
  onEnrollGrant,
  onRevokeGrant,
}: AgentGatePanelProps) {
  const [grantRole, setGrantRole] = useState<"viewer" | "editor" | "admin">("viewer");
  const alphaGrant = grants.find(
    (grant) => grant.teamId === "team-alpha" && grant.status === "active",
  );
  const canManageAlphaGrant = agent.ownerUserId === "user-a";
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
      <div className="team-grant-section">
        <div className="agentgate-section-title">
          <strong>Persistent Team Agent enrollment</strong>
          <span>
            Team Alpha · {canManageAlphaGrant ? "admin controls" : "admin required"}
          </span>
        </div>
        <p className="agentgate-help">
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

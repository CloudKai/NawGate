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

function humanName(value: string): string {
  return value === "user-a" ? "User A" : value === "user-b" ? "User B" : "User C · Org A reviewer";
}

export function DelegationReceipt({ agent, approvals, audit }: DelegationReceiptProps) {
  const approval = [...approvals].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  )[0];
  if (!approval) return null;

  const related = audit.filter((event) => event.approvalId === approval.id);
  const decisions = approval.approvalDecisions ?? [];
  const requiredApprovalCount = approval.requiredApprovalCount ?? 1;
  const requiredApprovalRoles = approval.requiredApprovalRoles ?? ["owner"];
  const requesterHumanId = approval.requesterHumanId ?? approval.humanId;
  const riskVersion = approval.riskVersion ?? "risk-v1";
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
        <div><dt>Requester</dt><dd>{humanName(requesterHumanId)}</dd></div>
        <div><dt>Agent</dt><dd>{agent.name}</dd></div>
        <div><dt>Run</dt><dd>{shortId(approval.runId)}</dd></div>
        <div><dt>Action</dt><dd>{approval.action}</dd></div>
        <div><dt>Resource</dt><dd>{approval.resourceId}</dd></div>
        <div><dt>Destination</dt><dd>{approval.destination ?? "—"}{approval.destinationRevision ? ` · v${approval.destinationRevision}` : ""}</dd></div>
        <div><dt>Resource class</dt><dd>{approval.resourceClassification ?? "—"}</dd></div>
        <div><dt>Team membership</dt><dd>{approval.humanRole ?? "—"}</dd></div>
        <div><dt>Persistent grant</dt><dd>{approval.agentRole ?? "—"}</dd></div>
        <div><dt>Grant ID</dt><dd>{approval.grantId ? shortId(approval.grantId) : "—"}</dd></div>
        <div><dt>Team / bundle</dt><dd>{approval.teamId ? `${approval.teamId} · v${approval.bundleVersion ?? "—"}` : "—"}</dd></div>
        <div><dt>Allowed scope</dt><dd>{approval.effectiveScope?.join(", ") ?? "—"}</dd></div>
        <div><dt>Temporary JIT</dt><dd>{approval.temporaryScope?.join(" · ") ?? "None"}</dd></div>
        <div><dt>Risk</dt><dd>{approval.risk}</dd></div>
        <div><dt>Risk policy</dt><dd>{riskVersion}</dd></div>
        <div><dt>Approvals</dt><dd>{decisions.length} / {requiredApprovalCount} · {requiredApprovalRoles.join(" + ")}</dd></div>
        <div><dt>Decisions</dt><dd>{decisions.length === 0 ? "Pending" : decisions.map((decision) => `${humanName(decision.humanId)} · ${decision.role} · ${decision.decision}`).join("; ")}</dd></div>
        <div><dt>Reason</dt><dd>{pretty(approval.reasonCode)}</dd></div>
        <div><dt>Policy</dt><dd>{policyEvent?.policyVersion ?? "bouncer-v5"}</dd></div>
        <div><dt>Enforcement</dt><dd>{policyEvent?.enforcementPoint ?? "RuntimeGateway"}</dd></div>
        <div><dt>Side effect</dt><dd>{policyEvent?.protectedActionExecuted ? "Executed" : "Not executed"}</dd></div>
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

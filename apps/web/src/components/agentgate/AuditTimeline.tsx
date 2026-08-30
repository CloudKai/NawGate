import type { AuditEvent } from "../../types";

interface AuditTimelineProps {
  events: AuditEvent[];
  onViewReplay?: (runId: string) => void;
}

function label(value: string | null): string {
  return value ? value.replaceAll("_", " ") : "—";
}

function decisionLabel(event: AuditEvent): string {
  const labels: Record<string, string> = {
    "policy.allow": "ALLOW",
    "policy.deny": "DENY",
    "policy.approval_required": "APPROVAL REQUIRED",
    "approval.approved": "APPROVED",
    "approval.denied": "DENIED",
    "approval.expired": "EXPIRED",
    "approval.revoked": "APPROVAL REVOKED",
    "runtime_identity.issued": "RUN IDENTITY ISSUED",
    "runtime_identity.revoked": "RUN IDENTITY REVOKED",
    "capability.issued": "CAPABILITY ISSUED",
    "capability.consumed": "CAPABILITY CONSUMED",
    "protected_action.succeeded": "SUCCESS",
    "protected_action.failed": "FAILURE",
  };
  return labels[event.eventType] ?? (event.status === "failure" ? "FAILURE" : label(event.eventType));
}

export function AuditTimeline({ events, onViewReplay }: AuditTimelineProps) {
  const latest = [...events].reverse().slice(0, 8);
  if (latest.length === 0) {
    return (
      <p className="agentgate-empty">No AgentGate decisions yet. Run a protected action to generate evidence.</p>
    );
  }
  return (
    <ol className="audit-timeline">
      {latest.map((event) => (
        <li key={event.id} className="audit-event">
          <span className={"audit-event-dot audit-dot-" + event.status} />
          <div className="audit-event-copy">
            <div className="audit-event-heading">
              <strong>{decisionLabel(event)}</strong>
              <div className="audit-event-actions">
                {event.runId && onViewReplay && (
                  <button
                    type="button"
                    className="replay-link-btn"
                    onClick={() => onViewReplay(event.runId!)}
                    title="View Flight Recording & Replay"
                  >
                    <span>▶</span> Replay
                  </button>
                )}
                <time>{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
              </div>
            </div>
            <span>{label(event.action)} · {label(event.resourceId)} · {label(event.reasonCode)}</span>
            {event.explanation && <p className="audit-explanation">{event.explanation}</p>}
            {(event.policyVersion || event.enforcementPoint) && (
              <small>
                {event.policyVersion ?? "No policy version"} · {event.enforcementPoint ?? "Unknown enforcement point"}
                {event.protectedActionExecuted === true ? " · side effect executed" : " · no side effect"}
              </small>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

import { useEffect } from "react";
import type { ReplayPayload } from "../../types";

interface FlightReplayModalProps {
  replay: ReplayPayload | null;
  loading: boolean;
  onClose: () => void;
}

export function FlightReplayModal({ replay, loading, onClose }: FlightReplayModalProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!loading && !replay) return null;

  return (
    <div className="modal-backdrop" onMouseDown={onClose} role="dialog" aria-modal="true">
      <div
        className="modal replay-modal"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <div className="replay-heading-row">
              <span className="eyebrow">Flight Data Recorder</span>
              {replay && (
                <span className={"status status-" + replay.status}>
                  <span className="status-dot" />
                  {replay.status}
                </span>
              )}
            </div>
            <h2>Deterministic Run Replay</h2>
            <p>Post-mortem blackbox execution telemetry and sanitized trace.</p>
          </div>
          <button type="button" className="close-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {loading ? (
          <div className="replay-loading">
            <span className="spinner" />
            <p>Loading flight data recording…</p>
          </div>
        ) : replay ? (
          <div className="replay-content">
            <div className="replay-banner">
              <div className="dlp-badge">
                <span className="dlp-badge-icon">🔒</span>
                <span>DLP Proxy Active: Sensitive keys, tokens, and PII sanitized in telemetry</span>
              </div>
              <div className="replay-meta-pills">
                <span className="meta-pill">
                  <strong>Duration:</strong>{" "}
                  {replay.durationMs >= 1000
                    ? `${(replay.durationMs / 1000).toFixed(2)}s`
                    : `${replay.durationMs}ms`}
                </span>
                <span className="meta-pill">
                  <strong>Run ID:</strong> <code>{replay.runId.slice(0, 8)}…</code>
                </span>
              </div>
            </div>

            <div className="token-metrics-grid">
              <div className="token-card">
                <span className="token-label">Input Tokens</span>
                <strong className="token-value">{replay.usage?.inputTokens ?? "—"}</strong>
              </div>
              <div className="token-card">
                <span className="token-label">Output Tokens</span>
                <strong className="token-value">{replay.usage?.outputTokens ?? "—"}</strong>
              </div>
              <div className="token-card">
                <span className="token-label">Cached Tokens</span>
                <strong className="token-value">{replay.usage?.cachedInputTokens ?? "0"}</strong>
              </div>
            </div>

            <section className="replay-section">
              <span className="section-label">User Prompt</span>
              <pre className="replay-box replay-prompt">{replay.prompt}</pre>
            </section>

            <section className="replay-section">
              <span className="section-label">
                {replay.status === "failed" ? "Failure Details / Error" : "Assistant Response"}
              </span>
              <pre className={"replay-box " + (replay.status === "failed" ? "replay-error" : "replay-output")}>
                {replay.error ? replay.error : replay.output || "No output captured."}
              </pre>
            </section>

            {replay.auditEvents.length > 0 && (
              <section className="replay-section">
                <span className="section-label">AgentGate Decision Trail ({replay.auditEvents.length} events)</span>
                <div className="replay-audit-list">
                  {replay.auditEvents.map((evt) => (
                    <div key={evt.id} className="replay-audit-item">
                      <span className={"audit-event-dot audit-dot-" + evt.status} />
                      <div className="replay-audit-copy">
                        <div className="replay-audit-title">
                          <strong>{evt.eventType}</strong>
                          {evt.decision && <span className={"decision-tag " + evt.decision}>{evt.decision.toUpperCase()}</span>}
                        </div>
                        {evt.explanation && <p className="replay-audit-desc">{evt.explanation}</p>}
                        <small>
                          {evt.action ? `action: ${evt.action} · ` : ""}
                          {evt.resourceId ? `resource: ${evt.resourceId} · ` : ""}
                          {evt.enforcementPoint ?? "AgentGate"}
                        </small>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        ) : (
          <div className="replay-empty">
            <p>No flight data available for this run.</p>
          </div>
        )}

        <div className="modal-footer">
          <button type="button" className="button button-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

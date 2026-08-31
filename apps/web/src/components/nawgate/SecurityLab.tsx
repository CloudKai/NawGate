import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { SecurityLabResult, SecurityLabScenario } from "../../types";

interface SecurityLabProps {
  agentId: string;
  onStateChanged: () => void;
}

const scenarios: { id: SecurityLabScenario; label: string; description: string }[] = [
  { id: "own-project", label: "Own project", description: "User A → project-a" },
  { id: "cross-user-project", label: "Cross-user deny", description: "User A → project-b" },
  { id: "alpha-internal", label: "Alpha internal", description: "Persistent grant → internal file" },
  { id: "alpha-restricted-jit", label: "Alpha restricted JIT", description: "Viewer → approval → one-use read → Run closes" },
  { id: "beta-cross-team", label: "Beta cross-team", description: "No trusted membership" },
  { id: "forged-team-admin", label: "Forged admin", description: "Trusted Run rejects injected role/team fields" },
  { id: "replay-consumed-approval", label: "Replay capability", description: "One-use JIT replay" },
  { id: "revoke-active-run", label: "Revoke Run", description: "Authority revoked before action" },
  { id: "revoke-grant", label: "Revoke grant", description: "Revoke persistent enrollment" },
  { id: "queued-after-revoke", label: "Queued after revoke", description: "Initial allow → queued → revoke → final recheck deny" },
];

const RESULT_LIMIT = 4;
const RESULT_AUTO_DISMISS_MS = 12_000;

export function mergeSecurityLabResult(
  current: SecurityLabResult[],
  next: SecurityLabResult,
): SecurityLabResult[] {
  return [next, ...current.filter((result) => result.scenario !== next.scenario)].slice(
    0,
    RESULT_LIMIT,
  );
}

export function shouldAutoDismissSecurityLabResult(result: SecurityLabResult): boolean {
  return result.operationState !== "pending_approval";
}

function statusClass(result: SecurityLabResult): string {
  return result.status === "success"
    ? "security-lab-result security-lab-allow"
    : result.status === "approval_required"
      ? "security-lab-result security-lab-pending"
      : "security-lab-result security-lab-deny";
}

export function SecurityLab({ agentId, onStateChanged }: SecurityLabProps) {
  const [running, setRunning] = useState<SecurityLabScenario | null>(null);
  const [results, setResults] = useState<SecurityLabResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const dismissTimers = useRef(new Map<SecurityLabScenario, number>());

  const clearDismissTimer = useCallback((scenario: SecurityLabScenario) => {
    const timer = dismissTimers.current.get(scenario);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      dismissTimers.current.delete(scenario);
    }
  }, []);

  const dismissResult = useCallback(
    (result: SecurityLabResult) => {
      clearDismissTimer(result.scenario);
      setResults((current) =>
        current.filter((candidate) => candidate.requestId !== result.requestId),
      );
    },
    [clearDismissTimer],
  );

  const showResult = useCallback(
    (result: SecurityLabResult) => {
      clearDismissTimer(result.scenario);
      setResults((current) => mergeSecurityLabResult(current, result));
      if (!shouldAutoDismissSecurityLabResult(result)) return;

      const timer = window.setTimeout(() => {
        setResults((current) =>
          current.filter((candidate) => candidate.requestId !== result.requestId),
        );
        if (dismissTimers.current.get(result.scenario) === timer) {
          dismissTimers.current.delete(result.scenario);
        }
      }, RESULT_AUTO_DISMISS_MS);
      dismissTimers.current.set(result.scenario, timer);
    },
    [clearDismissTimer],
  );

  useEffect(() => {
    setResults([]);
    setError(null);
    return () => {
      for (const timer of dismissTimers.current.values()) window.clearTimeout(timer);
      dismissTimers.current.clear();
    };
  }, [agentId]);

  const hasPendingJit = results.some(
    (result) =>
      result.scenario === "alpha-restricted-jit" &&
      result.operationState === "pending_approval",
  );

  const runScenario = async (scenario: SecurityLabScenario) => {
    setRunning(scenario);
    setError(null);
    try {
      const result = await api.securityLab(agentId, scenario);
      showResult(result);
      onStateChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunning(null);
    }
  };

  const continueJit = async (scenarioId: string, cancel = false) => {
    setRunning("alpha-restricted-jit");
    setError(null);
    try {
      const result = cancel
        ? await api.cancelSecurityLabJit(agentId, scenarioId)
        : await api.continueSecurityLabJit(agentId, scenarioId);
      showResult(result);
      onStateChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunning(null);
    }
  };

  return (
    <article className="security-lab" aria-labelledby="security-lab-title">
      <div className="nawgate-section-title">
        <div>
          <strong id="security-lab-title">Security Lab</strong>
          <span>real RuntimeGateway checks</span>
        </div>
        <span>local demo</span>
      </div>
      <p className="nawgate-help">
        Each button uses a short-lived server-side Run and shows redacted RuntimeGateway evidence. Protected payloads and credentials stay hidden.
      </p>
      <div className="security-lab-actions">
        {scenarios.map((scenario) => (
          <button
            className="security-lab-button"
            key={scenario.id}
            type="button"
            disabled={running !== null || hasPendingJit}
            onClick={() => void runScenario(scenario.id)}
            title={
              hasPendingJit
                ? "Complete or cancel the pending JIT request first"
                : scenario.description
            }
          >
            {running === scenario.id ? "Testing…" : scenario.label}
          </button>
        ))}
      </div>
      {error && <p className="security-lab-error" role="alert">{error}</p>}
      <div className="security-lab-results" aria-live="polite">
        {results.map((result) => (
          <div className={statusClass(result)} key={result.runId + result.requestId}>
            <div className="security-lab-result-heading">
              <strong>{scenarios.find((scenario) => scenario.id === result.scenario)?.label}</strong>
              <div className="security-lab-result-status">
                <span>{result.decision.toUpperCase()}</span>
                {shouldAutoDismissSecurityLabResult(result) && (
                  <button
                    type="button"
                    onClick={() => dismissResult(result)}
                    aria-label={`Dismiss ${result.scenario} result`}
                    title="Dismiss result"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
            <span>{result.action} · {result.resourceId} · {result.reasonCode}</span>
            <small>
              {result.humanId} · {result.agentId.slice(0, 8)} · Run {result.runId.slice(0, 8)} · {result.teamId ?? "no team"}
            </small>
            <small>
              {result.initialDecision ? `initial ${result.initialDecision}` : "single decision"} · {result.operationState} · {result.revocationPerformed ? "revoked" : "not revoked"}
            </small>
            <small>
              {result.policyVersion} · {result.enforcementPoint} · {result.protectedActionExecuted ? "side effect executed" : "no side effect"}
            </small>
            <p>{result.summary}</p>
            {result.scenario === "alpha-restricted-jit" && result.scenarioId && result.operationState === "pending_approval" && (
              <div className="security-lab-result-actions">
                <button type="button" disabled={running !== null} onClick={() => void continueJit(result.scenarioId!)}>
                  Complete approved JIT
                </button>
                <button type="button" disabled={running !== null} onClick={() => void continueJit(result.scenarioId!, true)}>
                  Cancel JIT
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </article>
  );
}

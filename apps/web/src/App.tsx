import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import { NawGatePanel } from "./components/nawgate/NawGatePanel";
import { DemoActorSwitch } from "./components/nawgate/DemoActorSwitch";
import { TeamMembershipPanel } from "./components/nawgate/TeamMembershipPanel";
import { TeamGraphVisualizer } from "./components/nawgate/TeamGraphVisualizer";
import type {
  Agent,
  AgentTeamGrant,
  AgentRun,
  ApprovalRecord,
  AuditEvent,
  AuditIntegrityReport,
  HumanId,
  HumanPrincipal,
  Message,
  SystemInfo,
  TeamId,
  TeamMembership,
  TeamRole,
  TeamRun,
} from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [activeTeamRun, setActiveTeamRun] = useState<TeamRun | null>(null);
  const [showDAGDrawer, setShowDAGDrawer] = useState(false);
  const [actor, setActor] = useState<HumanPrincipal | null>(null);
  const [users, setUsers] = useState<HumanPrincipal[]>([]);
  const [memberships, setMemberships] = useState<TeamMembership[]>([]);
  const [manageableMemberships, setManageableMemberships] = useState<TeamMembership[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [approvalHistory, setApprovalHistory] = useState<ApprovalRecord[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [auditIntegrity, setAuditIntegrity] = useState<AuditIntegrityReport | null>(null);
  const [grants, setGrants] = useState<AgentTeamGrant[]>([]);
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);
  const [revocationBusy, setRevocationBusy] = useState(false);
  const [grantBusyId, setGrantBusyId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const selectedAgentGrant = useMemo(
    () => grants.find((g) => g.agentId === selected?.id && g.status === "active") ?? null,
    [grants, selected],
  );

  const teamMembers = useMemo(() => {
    if (!selectedAgentGrant) return [];
    const teamAgentIds = new Set(
      grants
        .filter((g) => g.teamId === selectedAgentGrant.teamId && g.status === "active")
        .map((g) => g.agentId),
    );
    return agents.filter((a) => teamAgentIds.has(a.id));
  }, [grants, selectedAgentGrant, agents]);

  const isMultiAgentTeam = teamMembers.length > 1;

  const refreshAgents = useCallback(async (selectFirst = true) => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    if (!selectFirst) return;
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const refreshGate = useCallback(async (agentId: string) => {
    const [pendingResult, allApprovalResult, auditResult, grantResult, teamRunResult] = await Promise.all([
      api.approvals(agentId, "pending"),
      api.approvals(agentId),
      api.audit(agentId),
      api.teamGrants(agentId),
      api.latestTeamRun(agentId).catch(() => ({ teamRun: null })),
    ]);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setApprovals(pendingResult.approvals);
      setApprovalHistory(allApprovalResult.approvals);
      setAudit(auditResult.audit);
      setAuditIntegrity(auditResult.integrity);
      setGrants(grantResult.grants);
      if (teamRunResult.teamRun) {
        setActiveTeamRun(teamRunResult.teamRun);
      }
    }
  }, []);

  const bootstrap = useCallback(async () => {
    const session = await api.demoSession("user-a");
    setActor(session.user);
    const [userResult, membershipResult, manageableResult] = await Promise.all([
      api.demoUsers(),
      api.teamMemberships(),
      api.manageableTeamMemberships(),
    ]);
    setUsers(userResult.users);
    setMemberships(membershipResult.memberships);
    setManageableMemberships(manageableResult.memberships);
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setActiveTeamRun(null);
    setShowSettings(false);
    setApprovals([]);
    setApprovalHistory([]);
    setAudit([]);
    setAuditIntegrity(null);
    setGrants([]);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    void Promise.all([
      refreshMessages(selectedId),
      api.runs(selectedId),
      refreshGate(selectedId),
      api.latestTeamRun(selectedId).catch(() => ({ teamRun: null })),
    ])
      .then(([, result, , teamRunResult]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (teamRunResult?.teamRun) {
          setActiveTeamRun(teamRunResult.teamRun);
        }
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            selectedIdRef.current === selectedId &&
              setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) => {
        if (!cancelled && selectedIdRef.current === selectedId) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshGate, refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        if (!mountedRef.current) return;
        const [result, teamRunResult] = await Promise.all([
          api.run(runId),
          api.latestTeamRun(agentId).catch(() => ({ teamRun: null })),
          refreshMessages(agentId),
          refreshGate(agentId),
        ]);
        if (selectedIdRef.current === agentId) {
          setActiveRun(result.run);
          if (teamRunResult?.teamRun) {
            setActiveTeamRun(teamRunResult.teamRun);
          }
        }
        if (!["queued", "running"].includes(result.run.status)) {
          const finalTeam = await api.latestTeamRun(agentId).catch(() => ({ teamRun: null }));
          if (finalTeam?.teamRun && selectedIdRef.current === agentId) {
            setActiveTeamRun(finalTeam.teamRun);
          }
          await Promise.all([refreshMessages(agentId), refreshAgents(), refreshGate(agentId)]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const switchActor = async (userId: HumanId) => {
    if (actor?.id === userId) return;
    setBusy(true);
    setError(null);
    try {
      const session = await api.demoSession(userId);
      const [membershipResult, manageableResult] = await Promise.all([
        api.teamMemberships(),
        api.manageableTeamMemberships(),
      ]);
      setActor(session.user);
      setMemberships(membershipResult.memberships);
      setManageableMemberships(manageableResult.memberships);
      setSelectedId(null);
      setMessages([]);
      setActiveRun(null);
      setApprovals([]);
      setApprovalHistory([]);
      setAudit([]);
      await refreshAgents(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const addTeamMembership = async (input: {
    memberId: HumanId;
    teamId: TeamId;
    role: TeamRole;
  }) => {
    setError(null);
    try {
      const { membership } = await api.addTeamMembership(input);
      if (membership.humanId === actor?.id) {
        setMemberships((current) =>
          current.some(
            (candidate) =>
              candidate.teamId === membership.teamId && candidate.humanId === membership.humanId,
          )
            ? current
            : [...current, membership],
        );
      }
      setManageableMemberships((current) =>
        current.some(
          (candidate) =>
            candidate.teamId === membership.teamId && candidate.humanId === membership.humanId,
        )
          ? current
          : [...current, membership],
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const removeTeamMembership = async (input: { memberId: HumanId; teamId: TeamId }) => {
    setError(null);
    try {
      const { membership } = await api.removeTeamMembership(input);
      setMemberships((current) =>
        current.filter(
          (candidate) =>
            candidate.teamId !== membership.teamId || candidate.humanId !== membership.humanId,
        ),
      );
      setManageableMemberships((current) =>
        current.filter(
          (candidate) =>
            candidate.teamId !== membership.teamId || candidate.humanId !== membership.humanId,
        ),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const decideApproval = async (approvalId: string, decision: "approve" | "deny") => {
    if (!selected) return;
    setApprovalBusyId(approvalId);
    setError(null);
    try {
      if (decision === "approve") await api.approve(approvalId);
      else await api.deny(approvalId);
      await refreshGate(selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setApprovalBusyId(null);
    }
  };

  const revokeAccess = async () => {
    if (!selected) return;
    setRevocationBusy(true);
    setError(null);
    try {
      await api.revokeAccess(selected.id);
      await Promise.all([refreshAgents(), refreshGate(selected.id)]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRevocationBusy(false);
    }
  };

  const enrollTeamGrant = async (role: "viewer" | "editor" | "admin") => {
    if (!selected) return;
    setGrantBusyId("enroll");
    setError(null);
    try {
      await api.enrollTeamGrant(selected.id, { teamId: "team-alpha", role });
      await refreshGate(selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setGrantBusyId(null);
    }
  };

  const revokeTeamGrant = async (grantId: string) => {
    if (!selected) return;
    setGrantBusyId(grantId);
    setError(null);
    try {
      await api.revokeTeamGrant(selected.id, grantId);
      await refreshGate(selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setGrantBusyId(null);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
        if (result.teamRun) {
          setActiveTeamRun(result.teamRun);
          setShowDAGDrawer(true);
        }
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <DemoActorSwitch actor={actor} disabled={busy} onSwitch={switchActor} />

        <TeamMembershipPanel
          actor={actor}
          users={users}
          memberships={memberships}
          manageableMemberships={manageableMemberships}
          disabled={busy}
          onAdd={addTeamMembership}
          onRemove={removeTeamMembership}
        />

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => {
            const agentGrant = grants.find((g) => g.agentId === agent.id && g.status === "active");
            return (
              <button
                className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
                key={agent.id}
                onClick={() => setSelectedId(agent.id)}
              >
                <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
                <div className="agent-card-copy">
                  <div className="agent-card-name-row">
                    <strong>{agent.name}</strong>
                    {agentGrant && (
                      <span className="agent-team-tag">{agentGrant.teamId}</span>
                    )}
                  </div>
                  <span>{agent.description || "Coding Agent"}</span>
                </div>
                <span className={"mini-dot mini-" + agent.status} />
              </button>
            );
          })}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.modelName ?? "Model provider not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.modelConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.modelConfigured
                  ? "Set the selected model provider key and model in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  {isMultiAgentTeam ? (
                    <div className="playground-team-header">
                      <div className="team-pill-badge">
                        <span className="team-badge-dot" />
                        <strong>{selectedAgentGrant?.teamId.toUpperCase()}</strong>
                        <span>Shared Channel</span>
                      </div>
                      <div className="team-member-chips">
                        {teamMembers.map((member) => (
                          <span
                            key={member.id}
                            className={`team-member-chip ${member.id === selected.id ? "current" : ""}`}
                            title={`${member.name} (${member.status})`}
                          >
                            <span className="team-member-avatar-mini">
                              {member.name.slice(0, 1).toUpperCase()}
                            </span>
                            <span className="team-member-name-mini">{member.name}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <>
                      <span className="eyebrow">Playground</span>
                      <h2>Build something with {selected.name}</h2>
                    </>
                  )}
                </div>

                <div className="playground-topbar-actions">
                  {activeTeamRun && (
                    <button
                      type="button"
                      className={`button button-dag-toggle ${activeTeamRun.status === "running" ? "is-running" : ""}`}
                      onClick={() => {
                        setShowDAGDrawer((prev) => !prev);
                        if (selected) {
                          void api.latestTeamRun(selected.id).then((res) => {
                            if (res.teamRun) setActiveTeamRun(res.teamRun);
                          });
                        }
                      }}
                      title="Toggle DAG Visualizer & Blackboard"
                    >
                      <span>Execution Graph</span>
                      {activeTeamRun.status === "running" ? (
                        <span className="dag-pulse-dot-sm" />
                      ) : (
                        <span className="dag-count-badge">
                          {activeTeamRun.graph.tasks.filter((t) => t.status === "completed").length}/
                          {activeTeamRun.graph.tasks.length}
                        </span>
                      )}
                    </button>
                  )}

                  <div className="session-info">
                    <span className="pulse" />
                    {selected.codexThreadId ? "Session connected" : "New session"}
                  </div>
                </div>
              </div>

              <TeamGraphVisualizer
                isOpen={showDAGDrawer}
                teamRun={activeTeamRun}
                agents={agents}
                onClose={() => setShowDAGDrawer(false)}
              />

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : (message.authorName || selected.name)}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>
                        {activeTeamRun && ["queued", "running"].includes(activeTeamRun.status)
                          ? `Team Collaboration (${activeTeamRun.graph.tasks.filter((t) => t.status === "running").length} agents active)`
                          : selected.name}
                      </strong>
                      <span>
                        {activeTeamRun && ["queued", "running"].includes(activeTeamRun.status)
                          ? "executing DAG tasks in workspace"
                          : "working in the Agent workspace"}
                      </span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      {approvals.length > 0
                        ? "NawGate is waiting for owner approval…"
                        : activeTeamRun && ["queued", "running"].includes(activeTeamRun.status)
                          ? "Agents are executing DAG tasks concurrently in the workspace…"
                          : "Codex is reading, editing, or running commands…"}
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null && ["queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>

            <NawGatePanel
              agent={selected}
              approvals={approvals}
              approvalHistory={approvalHistory}
              audit={audit}
              auditIntegrity={auditIntegrity}
              busyApprovalId={approvalBusyId}
              revocationBusy={revocationBusy}
              onApprove={(approvalId) => void decideApproval(approvalId, "approve")}
              onDeny={(approvalId) => void decideApproval(approvalId, "deny")}
              onRevokeAccess={() => void revokeAccess()}
              grants={grants}
              grantBusyId={grantBusyId}
              onEnrollGrant={(role) => void enrollTeamGrant(role)}
              onRevokeGrant={(grantId) => void revokeTeamGrant(grantId)}
              onLabStateChanged={() => void refreshGate(selected.id)}
            />
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import type { Agent, TaskNode, TeamRun } from "../../types";

interface TeamGraphVisualizerProps {
  isOpen: boolean;
  onClose: () => void;
  teamRun: TeamRun | null;
  agents: Agent[];
}

export function TeamGraphVisualizer({
  isOpen,
  onClose,
  teamRun,
  agents,
}: TeamGraphVisualizerProps) {
  const [activeTab, setActiveTab] = useState<"graph" | "blackboard">("graph");
  const [selectedTask, setSelectedTask] = useState<TaskNode | null>(null);
  const [copiedArtifactId, setCopiedArtifactId] = useState<string | null>(null);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Compute topological layers for DAG layout
  const { layers } = useMemo(() => {
    if (!teamRun || !teamRun.graph?.tasks) {
      return { layers: [] };
    }

    const tasks = teamRun.graph.tasks;
    const taskMap = new Map<string, TaskNode>(tasks.map((t) => [t.id, t]));
    const depthMap = new Map<string, number>();

    const getDepth = (taskId: string, visited = new Set<string>()): number => {
      if (visited.has(taskId)) return 0;
      if (depthMap.has(taskId)) return depthMap.get(taskId)!;

      visited.add(taskId);
      const task = taskMap.get(taskId);
      if (!task || task.dependsOn.length === 0) {
        depthMap.set(taskId, 0);
        return 0;
      }

      const maxParentDepth = Math.max(
        ...task.dependsOn.map((depId) => getDepth(depId, new Set(visited))),
      );
      const currentDepth = maxParentDepth + 1;
      depthMap.set(taskId, currentDepth);
      return currentDepth;
    };

    tasks.forEach((t) => getDepth(t.id));

    const maxDepth = Math.max(0, ...Array.from(depthMap.values()));
    const computedLayers: TaskNode[][] = Array.from({ length: maxDepth + 1 }, () => []);

    tasks.forEach((t) => {
      const depth = depthMap.get(t.id) || 0;
      computedLayers[depth].push(t);
    });

    return { layers: computedLayers };
  }, [teamRun]);

  if (!isOpen || !teamRun) return null;

  const totalTasks = teamRun.graph.tasks.length;
  const completedTasks = teamRun.graph.tasks.filter((t) => t.status === "completed").length;
  const runningTasks = teamRun.graph.tasks.filter((t) => t.status === "running").length;
  const failedTasks = teamRun.graph.tasks.filter((t) => t.status === "failed").length;
  const progressPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  const getAgent = (agentId: string) => agents.find((a) => a.id === agentId);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedArtifactId(id);
    setTimeout(() => setCopiedArtifactId(null), 2000);
  };

  return (
    <aside className="dag-drawer-backdrop" onClick={onClose}>
      <div
        className="dag-drawer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="DAG Execution Visualizer & Blackboard"
      >
        {/* Drawer Header */}
        <header className="dag-drawer-header">
          <div className="dag-drawer-header-left">
            <div className="dag-team-pill">
              <span className="dag-team-indicator" />
              <strong>{teamRun.teamId.toUpperCase()}</strong>
            </div>
            <div className={`dag-badge dag-badge-${teamRun.status}`}>
              {teamRun.status === "running" && <span className="dag-pulse-dot" />}
              {teamRun.status.toUpperCase()}
            </div>
            <span className="dag-progress-meta">
              {completedTasks}/{totalTasks} done
              {runningTasks > 0 && ` · ${runningTasks} running`}
            </span>
          </div>

          <div className="dag-drawer-header-right">
            <nav className="dag-tab-nav" aria-label="Visualizer Tabs">
              <button
                type="button"
                className={`dag-tab-btn ${activeTab === "graph" ? "active" : ""}`}
                onClick={() => setActiveTab("graph")}
              >
                Task Graph ({totalTasks})
              </button>
              <button
                type="button"
                className={`dag-tab-btn ${activeTab === "blackboard" ? "active" : ""}`}
                onClick={() => setActiveTab("blackboard")}
              >
                Blackboard (
                {(teamRun.blackboard?.artifacts?.length || 0) +
                  (teamRun.blackboard?.createdFiles?.length || 0)}
                )
              </button>
            </nav>
            <button
              type="button"
              className="dag-close-button"
              onClick={onClose}
              aria-label="Close Drawer"
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>
        </header>

        {/* Global Progress Track */}
        <div className="dag-progress-track">
          <div
            className={`dag-progress-bar-fill ${failedTasks > 0 ? "has-error" : ""}`}
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        {/* Drawer Content */}
        <div className="dag-drawer-content">
          {activeTab === "graph" ? (
            <div className="dag-graph-view">
              <div className="dag-graph-canvas">
                {layers.map((layerTasks, layerIdx) => (
                  <div className="dag-phase-column" key={`phase-${layerIdx}`}>
                    <div className="dag-phase-header">
                      <span className="dag-phase-badge">Phase {layerIdx + 1}</span>
                      <span className="dag-phase-count">{layerTasks.length} task{layerTasks.length > 1 ? "s" : ""}</span>
                    </div>

                    <div className="dag-phase-tasks">
                      {layerTasks.map((task) => {
                        const assignedAgent = getAgent(task.assignedAgentId);
                        const isSelected = selectedTask?.id === task.id;

                        return (
                          <div
                            key={task.id}
                            className={`dag-task-card status-${task.status} ${isSelected ? "selected" : ""}`}
                            onClick={() => setSelectedTask(task)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") setSelectedTask(task);
                            }}
                            role="button"
                            tabIndex={0}
                          >
                            <div className="dag-task-top">
                              <div className="dag-agent-badge">
                                <span className="dag-agent-avatar-circle">
                                  {assignedAgent?.name.slice(0, 1).toUpperCase() || "A"}
                                </span>
                                <span className="dag-agent-label">
                                  {assignedAgent?.name || "Agent"}
                                </span>
                              </div>
                              <span className={`dag-status-tag tag-${task.status}`}>
                                {task.status === "running" && <span className="dag-spinner-inline" />}
                                {task.status}
                              </span>
                            </div>

                            <h4 className="dag-task-title">{task.title}</h4>
                            <p className="dag-task-desc">{task.description}</p>

                            {task.dependsOn.length > 0 && (
                              <div className="dag-task-dependencies">
                                <span>Depends on:</span>
                                {task.dependsOn.map((depId) => (
                                  <span key={depId} className="dag-dep-chip">
                                    {depId}
                                  </span>
                                ))}
                              </div>
                            )}

                            {task.durationMs !== undefined && task.durationMs !== null && (
                              <div className="dag-task-metrics">
                                <span>{task.durationMs}ms</span>
                                {task.output && <span className="dag-has-output">Output ready</span>}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              {/* Task Details Inspector */}
              {selectedTask && (
                <div className="dag-inspector-panel">
                  <div className="dag-inspector-header">
                    <div>
                      <span className="dag-eyebrow">Task Inspector</span>
                      <h3>{selectedTask.title}</h3>
                    </div>
                    <button
                      type="button"
                      className="dag-inspector-close"
                      onClick={() => setSelectedTask(null)}
                    >
                      ✕
                    </button>
                  </div>

                  <div className="dag-inspector-body">
                    <div className="dag-inspector-row">
                      <strong>Assigned Agent:</strong>
                      <span>{getAgent(selectedTask.assignedAgentId)?.name}</span>
                    </div>
                    <div className="dag-inspector-row">
                      <strong>Status:</strong>
                      <span className={`dag-status-tag tag-${selectedTask.status}`}>
                        {selectedTask.status}
                      </span>
                    </div>
                    <div className="dag-inspector-row">
                      <strong>Prompt Instruction:</strong>
                      <p>{selectedTask.description}</p>
                    </div>

                    {selectedTask.output && (
                      <div className="dag-inspector-block">
                        <div className="dag-inspector-block-header">
                          <strong>Output Result</strong>
                          <button
                            type="button"
                            className="button button-ghost button-sm"
                            onClick={() => copyToClipboard(selectedTask.output!, selectedTask.id)}
                          >
                            {copiedArtifactId === selectedTask.id ? "Copied" : "Copy Output"}
                          </button>
                        </div>
                        <pre className="dag-code-viewer">{selectedTask.output}</pre>
                      </div>
                    )}

                    {selectedTask.error && (
                      <div className="dag-inspector-block dag-error-block">
                        <strong>Error Details:</strong>
                        <pre>{selectedTask.error}</pre>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Blackboard View */
            <div className="dag-blackboard-view">
              <div className="dag-blackboard-grid">
                <div className="dag-blackboard-card">
                  <div className="dag-blackboard-card-header">
                    <h4>Published Schemas & Contracts ({teamRun.blackboard?.artifacts?.length || 0})</h4>
                  </div>
                  {teamRun.blackboard?.artifacts && teamRun.blackboard.artifacts.length > 0 ? (
                    <div className="dag-artifacts-container">
                      {teamRun.blackboard.artifacts.map((art) => (
                        <div key={art.id} className="dag-artifact-item">
                          <div className="dag-artifact-header">
                            <span className="dag-artifact-badge">{art.type}</span>
                            <strong>{art.name}</strong>
                            <span className="dag-artifact-author">
                              by {getAgent(art.agentId)?.name || art.agentId}
                            </span>
                            <button
                              type="button"
                              className="dag-copy-btn"
                              onClick={() => copyToClipboard(art.content, art.id)}
                            >
                              {copiedArtifactId === art.id ? "Copied" : "Copy"}
                            </button>
                          </div>
                          <pre className="dag-code-snippet">{art.content}</pre>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="dag-empty-state">
                      <p>No contracts or schemas published to the blackboard yet.</p>
                    </div>
                  )}
                </div>

                <div className="dag-blackboard-card">
                  <div className="dag-blackboard-card-header">
                    <h4>Created Workspace Files ({teamRun.blackboard?.createdFiles?.length || 0})</h4>
                  </div>
                  {teamRun.blackboard?.createdFiles && teamRun.blackboard.createdFiles.length > 0 ? (
                    <ul className="dag-files-bullet-list">
                      {teamRun.blackboard.createdFiles.map((file, i) => (
                        <li key={i}>
                          <code>{file}</code>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="dag-empty-state">
                      <p>No files registered in team blackboard.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

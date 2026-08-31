import { useMemo, useState } from "react";
import type { Agent, TaskNode, TeamRun } from "../../types";

interface TeamGraphVisualizerProps {
  teamRun: TeamRun | null;
  agents: Agent[];
  onClose?: () => void;
}

export function TeamGraphVisualizer({ teamRun, agents, onClose }: TeamGraphVisualizerProps) {
  const [selectedTask, setSelectedTask] = useState<TaskNode | null>(null);
  const [showBlackboard, setShowBlackboard] = useState(false);

  // Compute topological layers for DAG layout
  const { layers, tasksById } = useMemo(() => {
    if (!teamRun || !teamRun.graph?.tasks) {
      return { layers: [], tasksById: new Map<string, TaskNode>() };
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

    return { layers: computedLayers, tasksById: taskMap };
  }, [teamRun]);

  if (!teamRun || layers.length === 0) return null;

  const totalTasks = teamRun.graph.tasks.length;
  const completedTasks = teamRun.graph.tasks.filter((t) => t.status === "completed").length;
  const runningTasks = teamRun.graph.tasks.filter((t) => t.status === "running").length;
  const progressPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  const getAgent = (agentId: string) => agents.find((a) => a.id === agentId);

  return (
    <section className="team-dag-container" aria-label="Team DAG Visualizer">
      <header className="team-dag-header">
        <div className="team-dag-title-row">
          <div className="team-badge">
            <span className="team-badge-dot" />
            <strong>Team Collaboration: {teamRun.teamId}</strong>
          </div>
          <span className={`dag-status-pill dag-status-${teamRun.status}`}>
            {teamRun.status === "running" && <span className="dag-pulse" />}
            {teamRun.status.toUpperCase()}
          </span>
          <span className="dag-progress-text">
            {completedTasks}/{totalTasks} tasks completed
            {runningTasks > 0 && ` (${runningTasks} running in parallel)`}
          </span>
        </div>

        <div className="team-dag-actions">
          <button
            type="button"
            className={`button button-ghost button-sm ${showBlackboard ? "active" : ""}`}
            onClick={() => setShowBlackboard((v) => !v)}
          >
            📋 Shared Blackboard ({teamRun.blackboard?.artifacts?.length || 0})
          </button>
          {onClose && (
            <button type="button" className="dag-close-btn" onClick={onClose} aria-label="Minimize visualizer">
              ×
            </button>
          )}
        </div>
      </header>

      {/* Progress Bar */}
      <div className="dag-progress-bar">
        <div className="dag-progress-fill" style={{ width: `${progressPercent}%` }} />
      </div>

      {/* DAG Visualizer Canvas */}
      <div className="dag-canvas-scroll">
        <div className="dag-canvas">
          {layers.map((layerTasks, layerIdx) => (
            <div className="dag-layer" key={`layer-${layerIdx}`}>
              <div className="dag-layer-label">Phase {layerIdx + 1}</div>
              <div className="dag-layer-nodes">
                {layerTasks.map((task) => {
                  const assignedAgent = getAgent(task.assignedAgentId);
                  const isSelected = selectedTask?.id === task.id;

                  return (
                    <div
                      key={task.id}
                      className={`dag-node dag-node-${task.status} ${isSelected ? "selected" : ""}`}
                      onClick={() => setSelectedTask(task)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") setSelectedTask(task);
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="dag-node-header">
                        <div className="dag-agent-info">
                          <span className="dag-agent-avatar">
                            {assignedAgent?.name.slice(0, 1).toUpperCase() || "A"}
                          </span>
                          <span className="dag-agent-name">{assignedAgent?.name || "Agent"}</span>
                        </div>
                        <span className={`dag-node-status-badge status-${task.status}`}>
                          {task.status}
                        </span>
                      </div>

                      <div className="dag-node-body">
                        <strong>{task.title}</strong>
                        <p>{task.description}</p>
                      </div>

                      {task.dependsOn.length > 0 && (
                        <div className="dag-node-deps">
                          <span>Depends on:</span>
                          {task.dependsOn.map((depId) => (
                            <code key={depId}>{depId}</code>
                          ))}
                        </div>
                      )}

                      {task.durationMs !== undefined && task.durationMs !== null && (
                        <div className="dag-node-footer">
                          <span>⚡ {task.durationMs}ms</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Selected Task Details Drawer */}
      {selectedTask && (
        <div className="dag-task-details">
          <div className="dag-task-details-header">
            <div>
              <span className="eyebrow">Task Details</span>
              <h3>{selectedTask.title}</h3>
            </div>
            <button type="button" onClick={() => setSelectedTask(null)}>
              ×
            </button>
          </div>
          <p>
            <strong>Assigned Agent:</strong> {getAgent(selectedTask.assignedAgentId)?.name}
          </p>
          <p>
            <strong>Status:</strong> {selectedTask.status}
          </p>
          <p>
            <strong>Instruction:</strong> {selectedTask.description}
          </p>
          {selectedTask.output && (
            <div className="dag-task-output">
              <strong>Output Preview:</strong>
              <pre>{selectedTask.output}</pre>
            </div>
          )}
          {selectedTask.error && (
            <div className="dag-task-error">
              <strong>Error:</strong>
              <pre>{selectedTask.error}</pre>
            </div>
          )}
        </div>
      )}

      {/* Live Blackboard Drawer */}
      {showBlackboard && (
        <div className="dag-blackboard-drawer">
          <div className="dag-blackboard-header">
            <div>
              <span className="eyebrow">Team Memory</span>
              <h3>Live Blackboard State</h3>
            </div>
            <button type="button" onClick={() => setShowBlackboard(false)}>
              ×
            </button>
          </div>

          <div className="dag-blackboard-content">
            <div className="dag-blackboard-section">
              <h4>📦 Published Artifacts & Contracts ({teamRun.blackboard?.artifacts?.length || 0})</h4>
              {teamRun.blackboard?.artifacts && teamRun.blackboard.artifacts.length > 0 ? (
                <div className="dag-artifacts-list">
                  {teamRun.blackboard.artifacts.map((art) => (
                    <div key={art.id} className="dag-artifact-card">
                      <div className="dag-artifact-meta">
                        <span className="dag-artifact-type">{art.type}</span>
                        <strong>{art.name}</strong>
                        <span>by {getAgent(art.agentId)?.name || art.agentId}</span>
                      </div>
                      <pre>{art.content}</pre>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="dag-empty-text">No shared contracts or schemas published yet.</p>
              )}
            </div>

            <div className="dag-blackboard-section">
              <h4>📁 Files Created ({teamRun.blackboard?.createdFiles?.length || 0})</h4>
              {teamRun.blackboard?.createdFiles && teamRun.blackboard.createdFiles.length > 0 ? (
                <ul className="dag-files-list">
                  {teamRun.blackboard.createdFiles.map((file, i) => (
                    <li key={i}>
                      <code>{file}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="dag-empty-text">No files registered in blackboard.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

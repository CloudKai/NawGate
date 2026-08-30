import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { maskObject } from "./dlp-service.js";
import type { AuditEvent, HumanId } from "./types.js";
import type { RunStatus, RunUsage } from "../types.js";

export interface ReplayPayload {
  runId: string;
  agentId: string;
  ownerUserId: HumanId;
  prompt: string;
  output: string | null;
  error: string | null;
  status: RunStatus;
  usage: RunUsage | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  auditEvents: AuditEvent[];
}

export interface ReplaySummary {
  runId: string;
  status: RunStatus;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export function replayFilePath(dataDirectory: string, agentId: string, runId: string): string {
  // Sanitize path segments against path traversal
  const safeAgentId = agentId.replace(/[^a-zA-Z0-9_-]/g, "");
  const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(dataDirectory, "replays", safeAgentId, `${safeRunId}.json`);
}

/**
 * Persist blackbox flight data for an executed Run, sanitized through the DLP proxy.
 */
export async function recordFlightData(
  payload: ReplayPayload,
  dataDirectory: string,
): Promise<void> {
  const filePath = replayFilePath(dataDirectory, payload.agentId, payload.runId);
  await mkdir(path.dirname(filePath), { recursive: true });

  const sanitized = maskObject(payload);
  await writeFile(filePath, JSON.stringify(sanitized, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

/**
 * Retrieve saved flight recording for post-mortem debugging or deterministic replay.
 */
export async function getReplay(
  agentId: string,
  runId: string,
  dataDirectory: string,
): Promise<ReplayPayload | null> {
  const filePath = replayFilePath(dataDirectory, agentId, runId);
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as ReplayPayload;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * List summaries of saved flight replays for a specific agent.
 */
export async function listReplays(
  agentId: string,
  dataDirectory: string,
): Promise<ReplaySummary[]> {
  const safeAgentId = agentId.replace(/[^a-zA-Z0-9_-]/g, "");
  const dirPath = path.join(dataDirectory, "replays", safeAgentId);
  try {
    const files = await readdir(dirPath);
    const summaries: ReplaySummary[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const runId = file.slice(0, -5);
      const replay = await getReplay(agentId, runId, dataDirectory);
      if (replay) {
        summaries.push({
          runId: replay.runId,
          status: replay.status,
          startedAt: replay.startedAt,
          completedAt: replay.completedAt,
          durationMs: replay.durationMs,
        });
      }
    }
    return summaries.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

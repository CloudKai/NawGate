import type {
  Agent,
  AgentRun,
  ApprovalRecord,
  AuditEvent,
  HumanId,
  Message,
  SystemInfo,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

let authToken = "";
let humanSessionToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...(humanSessionToken
      ? { "X-AgentGate-Session": humanSessionToken }
      : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    message?: string;
    code?: string;
  };
  if (!response.ok) {
    throw new ApiError(
      data.error ?? data.message ?? "Request failed",
      response.status,
      data.code,
    );
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  demoSession: async (userId: HumanId) => {
    const session = await request<{
      sessionToken: string;
      user: { id: HumanId; name: string };
      expiresAt: string;
    }>("/api/demo/session", {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
    // Keep the human session in module memory only; never persist it in browser storage.
    humanSessionToken = session.sessionToken;
    return session;
  },
  approvals: (id: string, status?: ApprovalRecord["status"]) =>
    request<{ approvals: ApprovalRecord[] }>(
      "/api/agents/" + id + "/approvals" +
        (status ? "?status=" + encodeURIComponent(status) : ""),
    ),
  audit: (id: string, runId?: string, limit = 20) =>
    request<{ audit: AuditEvent[] }>(
      "/api/agents/" +
        id +
        "/audit?limit=" +
        limit +
        (runId ? "&runId=" + encodeURIComponent(runId) : ""),
    ),
  approve: (id: string) =>
    request<{ approval: ApprovalRecord }>("/api/approvals/" + id + "/approve", {
      method: "POST",
    }),
  deny: (id: string) =>
    request<{ approval: ApprovalRecord }>("/api/approvals/" + id + "/deny", {
      method: "POST",
    }),
  revokeAccess: (id: string) =>
    request<{ runId: string; status: "revoked"; approvalsRevoked: number }>(
      "/api/agents/" + id + "/revoke-access",
      { method: "POST" },
    ),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
};

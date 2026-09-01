# NawGate Observability & Replay Guide

This guide explains the **Data Loss Prevention (DLP Proxy)** and **Flight Data Recorder (Deterministic Run Replayer)** capabilities built into the **NawGate** delegated-access middleware.

---

## 1. Overview & Core Philosophy

Autonomous Agentic AI systems frequently read, generate, and execute code across multi-turn sessions. In enterprise environments, this introduces two critical risks:

1. **Sensitive Data Leakage**: Prompts, tool outputs, or assistant responses may accidentally expose API keys, bearer tokens, passwords, or PII into persistent databases and audit trails.
2. **Nondeterministic Blackbox Failures**: When an agent fails or behaves unexpectedly, developers lack structured telemetry to reconstruct the run's exact prompt, token consumption, policy decisions, and execution duration.

**NawGate** solves both challenges with backend-enforced middleware:

| Feature | Primary Purpose | Enforcement Point |
| :--- | :--- | :--- |
| **Real-Time DLP Proxy** | Intercepts & redacts secrets/PII before storage | `DLPService`, `AgentService`, `AuditService` |
| **Flight Data Recorder** | Serializes full blackbox run telemetry for replay & post-mortem analysis | `FlightRecorderService`, `MiddlewareRunner`, Web UI |

---

## 2. Architecture & Data Flow

```
                                 [ User / Playground ]
                                          │
                                          │ 1. User sends prompt
                                          ▼
                                   ┌──────────────┐
                                   │  DLP Proxy   │ ── Sanitizes API keys, tokens, emails
                                   └──────────────┘
                                          │
                                          ▼
                              ┌───────────────────────┐
                              │     AgentService      │ ── Saves sanitized message to Store
                              └───────────────────────┘
                                          │
                                          ▼
                             ┌─────────────────────────┐
                             │    MiddlewareRunner     │ ── Issues short-lived Run identity
                             └─────────────────────────┘
                                     │         │
                        2. Executes  │         │ 3. Intercepts runtime actions
                                     ▼         ▼
                              ┌─────────────┐ ┌────────────────┐
                              │ CodexRunner │ │ RuntimeGateway │ ── Records DLP-masked audit events
                              └─────────────┘ └────────────────┘
                                     │
                                     ▼
                            [ Run Completion ]
                                     │
                                     ▼
                       ┌───────────────────────────┐
                       │   Flight Data Recorder    │ ── Saves telemetry to data/replays/<agent>/<run>.json
                       └───────────────────────────┘
                                     │
                                     ▼
                        [ Web UI: Flight Replay Modal ]
```

---

## 3. Real-Time Data Masker / DLP Proxy

The **DLP Proxy** inspects all data passing through the middleware using fast, deterministic regex filters without any external network calls or LLM dependencies.

### Protected Data Patterns

| Sensitive Type | Pattern Target | Redacted Replacement |
| :--- | :--- | :--- |
| **OpenAI API Keys** | `sk-[a-zA-Z0-9_-]{20,}` | `[REDACTED_OPENAI_KEY]` |
| **Ark API Keys** | `ark-[a-zA-Z0-9_-]{20,}` | `[REDACTED_ARK_KEY]` |
| **Bearer Tokens** | `bearer <token-string>` | `Bearer [REDACTED_TOKEN]` |
| **Private Keys (PEM)** | `-----BEGIN ... PRIVATE KEY-----` | `[REDACTED_PRIVATE_KEY]` |
| **Credit Card Numbers** | Visa, MasterCard, Amex, Discover | `[REDACTED_CC]` |
| **Email Addresses** | Standard RFC email formats | `[REDACTED_EMAIL]` |
| **Secret Assignments** | `api_key = ...`, `password: ...` | `api_key: [REDACTED_SECRET]` |

### Zero-Leakage Guarantee
- **Message History**: User prompts and assistant responses are sanitized before writing to `db.json`.
- **Audit Logs**: All policy evaluations and reason explanations are sanitized.
- **Flight Telemetry**: Flight records strip out raw credentials while preserving structural IDs (`agentId`, `runId`, timestamps).

---

## 4. Flight Data Recorder (Deterministic Run Replayer)

Every agent turn produces a structured flight recording saved under:
```
data/replays/<agent-id>/<run-id>.json
```

### Telemetry Payload Structure
```json
{
  "runId": "00000000-0000-4000-8000-000000000002",
  "agentId": "00000000-0000-4000-8000-000000000001",
  "ownerUserId": "user-a",
  "prompt": "Analyze database logs with key [REDACTED_OPENAI_KEY]",
  "output": "Found 3 errors in database connection pool.",
  "error": null,
  "status": "completed",
  "usage": {
    "inputTokens": 450,
    "outputTokens": 82,
    "cachedInputTokens": 128
  },
  "startedAt": "2026-08-30T10:15:00.000Z",
  "completedAt": "2026-08-30T10:15:03.200Z",
  "durationMs": 3200,
  "auditEvents": [
    {
      "eventType": "policy.allow",
      "action": "resource.read",
      "resourceId": "project-a",
      "decision": "allow",
      "reasonCode": "owned_resource_read"
    }
  ]
}
```

---

## 5. How to Use in the Web Application

### 1. DLP Status Indicator
In the top-right header of the **NawGate Panel**, you will see the active status chip:
- **`🔒 DLP Active`** (with green pulsing indicator)
- Confirms real-time secret sanitization is active across all conversations and audit trails.

### 2. Inspecting a Run via Flight Replay
1. Navigate to an Agent in the Launchpad.
2. In the right-hand **NawGate Panel**, locate the **Audit Timeline**.
3. Next to any decision or run event, click the **`▶ Replay`** button.
4. The **Deterministic Run Replay Modal** opens with:
   - **Status & Duration**: High-precision execution duration (e.g. `3.20s` or `450ms`).
   - **Token Consumption**: Input tokens, cached tokens, and output tokens.
   - **Sanitized Prompt & Output**: Complete interaction history with secrets masked.
   - **Decision Trail**: The exact sequence of NawGate policy decisions, approvals, and capability leases.

---

## 6. End-to-End Scenarios

### Scenario 1: Accidental Secret Leak Interception

**Situation**: A developer tests the agent by pasting a prompt containing a production key and sensitive email:
> *"Use my key `sk-proj-98765432101234567890abcdef` to check server status for `alice.dev@company.com`."*

**What NawGate Does**:
1. `DLP Proxy` intercepts the string in `AgentService.sendMessage()`.
2. The message stored in the database and shown in the playground is sanitized to:
   > *"Use my key `[REDACTED_OPENAI_KEY]` to check server status for `[REDACTED_EMAIL]`."*
3. The raw API key is never written to disk, preventing accidental exposure in backups or git history.

---

### Scenario 2: Post-Mortem Debugging of a Failed Run

**Situation**: An Agent fails while executing a deployment task. The user sees a `Run failed` banner.

**What NawGate Does**:
1. `MiddlewareRunner` catches the failure in its lifecycle handler.
2. The exact error, timing, token usage, and audit records are recorded into `data/replays/<agentId>/<runId>.json`.
3. The user clicks **`▶ Replay`** on the failure event in the Audit Timeline.
4. The **Flight Replay Modal** displays:
   - Status: `FAILED` (highlighted in red)
   - Duration: `1.85s`
   - Token Usage: `Input: 180, Output: 0`
   - Failure Details: Exact error message explaining why the runner stopped.
   - Linked Audit Events: Any policy evaluations (e.g. `policy.deny`) that led to the failure.

---

### Scenario 3: Multi-Tenant Compliance & Authorization Isolation

**Situation**: `User A` and `User B` share the platform. `User B` tries to inspect `User A`'s flight recordings.

**What NawGate Does**:
1. `User B` sends a request to `GET /api/agents/<agent-a-id>/replays/<run-id>`.
2. Fastify backend evaluates the session token `X-NawGate-Session`.
3. `service.getAgent(id, actor)` detects that `agent-a` is owned by `user-a` (`ownerUserId !== actor.id`).
4. The request fails closed with HTTP `404 Agent not found`.
5. No telemetry, prompt text, or token data is exposed across tenant boundaries.

---

## 7. Verification & Testing Commands

To run the automated test suite for DLP and Flight Recorder:

```bash
# Run DLP unit tests
npx vitest run apps/server/src/nawgate/dlp-service.test.ts

# Run Flight Recorder unit tests
npx vitest run apps/server/src/nawgate/flight-recorder.test.ts

# Run Runtime API integration tests
npx vitest run apps/server/src/runtime-api.test.ts

# Run complete workspace check (Typecheck, All Tests, Builds)
npm run check
```

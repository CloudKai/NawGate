#!/usr/bin/env node

import { randomUUID } from "node:crypto";

const gatewayUrl = process.env.AGENTGATE_GATEWAY_URL?.trim();
const runtimeToken = process.env.AGENTGATE_RUNTIME_TOKEN?.trim();
const configuredWait = Number.parseInt(
  process.env.AGENTGATE_APPROVAL_WAIT_MS ?? "90000",
  10,
);
const maxWaitMs = Number.isFinite(configuredWait) && configuredWait > 0
  ? configuredWait
  : 90_000;

function usage() {
  process.stderr.write(
    "Usage: agentctl resource read <resource-id> | agentctl deploy <staging|production>\n",
  );
}

function fail(message) {
  process.stderr.write("AgentGate: " + message + "\n");
  process.exitCode = 1;
}

function parseCommand(args) {
  if (args.length === 3 && args[0] === "resource" && args[1] === "read") {
    return { action: "resource.read", resourceId: args[2], label: "resource.read " + args[2] };
  }
  if (args.length === 2 && args[0] === "deploy" && args[1] === "staging") {
    return { action: "deploy.staging", resourceId: "staging", label: "deploy.staging" };
  }
  if (args.length === 2 && args[0] === "deploy" && args[1] === "production") {
    return {
      action: "deploy.production",
      resourceId: "production",
      label: "deploy.production",
    };
  }
  return null;
}

function asObject(value) {
  return typeof value === "object" && value !== null ? value : {};
}

async function request(pathname, body) {
  const response = await fetch(new URL(pathname, gatewayUrl), {
    method: body ? "POST" : "GET",
    headers: {
      "X-AgentGate-Runtime": runtimeToken,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(10_000),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  return { status: response.status, payload: asObject(payload) };
}

function failureFor(payload, fallback) {
  const code = typeof payload.code === "string" ? payload.code : "";
  if (code === "APPROVAL_EXPIRED") return "Approval expired.";
  if (code === "APPROVAL_DENIED") return "The protected action was not permitted.";
  if (code === "INVALID_RUNTIME_CREDENTIAL" || code === "RUNTIME_CREDENTIAL_EXPIRED") {
    return "The Agent runtime credential is no longer valid.";
  }
  if (code === "IDEMPOTENCY_MISMATCH") return "The protected request could not be retried safely.";
  if (code === "ACTION_NOT_PERMITTED") return "The protected action was not permitted.";
  return fallback;
}

function printSuccess(command, payload, approval) {
  process.stdout.write(
    approval
      ? "AgentGate: owner approved once -> ALLOW\n"
      : "AgentGate: " + command.label + " -> ALLOW\n",
  );
  const result = asObject(payload.result);
  const detail = typeof result.content === "string"
    ? result.content
    : typeof result.summary === "string"
      ? result.summary
      : command.action === "deploy.production" || command.action === "deploy.staging"
        ? "Deployment completed."
        : "Protected action completed.";
  process.stdout.write(detail + "\n");
}

async function waitForApproval(command, requestId, approvalId) {
  process.stdout.write("Waiting for owner approval...\n");
  const deadline = Date.now() + maxWaitMs;
  let pollAfterMs = 1_000;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollAfterMs, remaining)));
    const response = await request("/api/runtime/approvals/" + approvalId);
    if (response.status !== 200) {
      fail(failureFor(response.payload, "Approval status could not be read."));
      return;
    }
    if (response.payload.status === "pending") {
      const next = Number(response.payload.pollAfterMs);
      pollAfterMs = Number.isFinite(next) && next > 0
        ? Math.max(100, Math.min(next, 1_000))
        : 1_000;
      continue;
    }
    if (response.payload.status === "denied" || response.payload.status === "expired") {
      fail(failureFor(response.payload, "The protected action was not permitted."));
      return;
    }
    if (response.payload.status !== "approved") {
      fail("Approval status was not recognized.");
      return;
    }
    const retried = await request("/api/runtime/actions", {
      requestId,
      action: command.action,
      resourceId: command.resourceId,
      approvalId,
    });
    if (retried.status !== 200 || retried.payload.status !== "success") {
      fail(failureFor(retried.payload, "The approved protected action failed."));
      return;
    }
    printSuccess(command, retried.payload, true);
    return;
  }
  fail("Timed out waiting for owner approval.");
}

async function main() {
  const command = parseCommand(process.argv.slice(2));
  if (!command) {
    usage();
    fail("Invalid command.");
    return;
  }
  if (!gatewayUrl || !runtimeToken) {
    fail("Agent runtime is not configured for protected actions.");
    return;
  }
  const requestId = randomUUID();
  let response;
  try {
    response = await request("/api/runtime/actions", {
      requestId,
      action: command.action,
      resourceId: command.resourceId,
    });
  } catch {
    fail("AgentGate is unavailable.");
    return;
  }
  if (response.status === 200 && response.payload.status === "success") {
    printSuccess(command, response.payload, false);
    return;
  }
  if (response.status === 202 && response.payload.status === "approval_required") {
    const approvalId = response.payload.approvalId;
    if (typeof approvalId !== "string" || !approvalId) {
      fail("Approval request was malformed.");
      return;
    }
    await waitForApproval(command, requestId, approvalId);
    return;
  }
  fail(failureFor(response.payload, "The protected action was not permitted."));
}

await main().catch(() => fail("AgentGate is unavailable."));

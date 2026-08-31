import type { AppConfig } from "./config.js";
import { ContainerCodexRunner } from "./container-codex-runner.js";
import { CodexRunner } from "./codex-runner.js";
import { AuditService } from "./nawgate/audit-service.js";
import { ApprovalService } from "./nawgate/approval-service.js";
import { MiddlewareRunner } from "./nawgate/middleware-runner.js";
import { RuntimeCredentialService } from "./nawgate/runtime-credential-service.js";
import type { JsonStore } from "./store.js";
import type { AgentRunner } from "./types.js";

export interface RunnerDependencies {
  credentials: RuntimeCredentialService;
  audit: AuditService;
  approvals?: ApprovalService;
}

export function createRunner(
  config: AppConfig,
  store: JsonStore,
  dependencies: RunnerDependencies = {
    credentials: new RuntimeCredentialService(Date.now, config.codexTimeoutMs),
    audit: new AuditService(store),
  },
): AgentRunner {
  const baseRunner =
    config.runtimeProvider === "container"
    ? new ContainerCodexRunner(config)
    : new CodexRunner(config);
  return new MiddlewareRunner(
    baseRunner,
    dependencies.credentials,
    dependencies.audit,
    config,
    dependencies.approvals,
  );
}

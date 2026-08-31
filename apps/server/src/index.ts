import path from "node:path";
import { AgentService } from "./agent-service.js";
import { ApprovalService } from "./agentgate/approval-service.js";
import { AgentTeamGrantService } from "./agentgate/agent-team-grant-service.js";
import { AuditService } from "./agentgate/audit-service.js";
import { DeterministicPolicyEngine } from "./agentgate/policy-engine.js";
import { ProtectedResourceService } from "./agentgate/protected-resource-service.js";
import { IdentityService } from "./agentgate/identity-service.js";
import { RuntimeCredentialService } from "./agentgate/runtime-credential-service.js";
import { RuntimeGateway } from "./agentgate/runtime-gateway.js";
import { SecurityLabService } from "./agentgate/security-lab-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const audit = new AuditService(store);
const approvals = new ApprovalService(store, audit);
const credentials = new RuntimeCredentialService(Date.now, config.codexTimeoutMs);
const grants = new AgentTeamGrantService(store, approvals, credentials, audit);
const resources = new ProtectedResourceService(store, approvals);
const gateway = new RuntimeGateway(
  new DeterministicPolicyEngine(),
  resources,
  audit,
  approvals,
  store,
  undefined,
  grants,
  credentials,
);
const securityLab = new SecurityLabService(gateway, approvals, audit, credentials, grants);
const runner = createRunner(config, store, { credentials, audit, approvals });
const identity = new IdentityService();
const service = new AgentService(config, store, workspaces, runner, approvals);
await service.initialize();

const app = await createApp(config, service, identity, {
  credentials,
  gateway,
  approvals,
  audit,
  grants,
  securityLab,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });

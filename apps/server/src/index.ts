import path from "node:path";
import { AgentService } from "./agent-service.js";
import { ApprovalService } from "./nawgate/approval-service.js";
import { ApprovalAuthorityService } from "./nawgate/approval-authority-service.js";
import { AgentTeamGrantService } from "./nawgate/agent-team-grant-service.js";
import { AuditService } from "./nawgate/audit-service.js";
import { DeterministicPolicyEngine } from "./nawgate/policy-engine.js";
import { ProtectedResourceService } from "./nawgate/protected-resource-service.js";
import { IdentityService } from "./nawgate/identity-service.js";
import { RuntimeCredentialService } from "./nawgate/runtime-credential-service.js";
import { RuntimeGateway } from "./nawgate/runtime-gateway.js";
import { DestinationCatalogueService } from "./nawgate/destination-catalogue.js";
import { ServerSideCredentialBroker } from "./nawgate/destination-broker.js";
import { LocalDestinationAdapter } from "./nawgate/local-destination-adapter.js";
import { SecurityLabService } from "./nawgate/security-lab-service.js";
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
const authorities = new ApprovalAuthorityService(store, approvals, audit);
const credentials = new RuntimeCredentialService(Date.now, config.codexTimeoutMs);
const grants = new AgentTeamGrantService(store, approvals, credentials, audit);
const destinations = new DestinationCatalogueService(store, approvals);
const destinationAdapter = new LocalDestinationAdapter(
  store,
  destinations,
  new ServerSideCredentialBroker(),
);
const resources = new ProtectedResourceService(store, approvals, destinationAdapter);
const gateway = new RuntimeGateway(
  new DeterministicPolicyEngine(),
  resources,
  audit,
  approvals,
  store,
  undefined,
  grants,
  credentials,
  destinations,
);
const securityLab = new SecurityLabService(gateway, approvals, audit, credentials, grants);
const runner = createRunner(config, store, { credentials, audit, approvals });
const identity = new IdentityService();
const service = new AgentService(config, store, workspaces, runner, approvals, audit);
await service.initialize();

const app = await createApp(config, service, identity, {
  credentials,
  gateway,
  approvals,
  audit,
  grants,
  securityLab,
  authorities,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalService } from "./approval-service.js";
import { AuditService } from "./audit-service.js";
import { DeterministicPolicyEngine } from "./policy-engine.js";
import { ProtectedResourceService } from "./protected-resource-service.js";
import { RuntimeCredentialService } from "./runtime-credential-service.js";
import { RuntimeGateway } from "./runtime-gateway.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { AgentService } from "../agent-service.js";
import { JsonStore } from "../store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);
const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "00000000-0000-4000-8000-000000000002";
const IMAGE = process.env.CONTAINER_RUNTIME_IMAGE ?? "volc-agent-runtime:local";
const temporaryDirectories: string[] = [];
const applications: { close: () => Promise<unknown> }[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("NawGate real-container smoke", () => {
  it.skipIf(process.env.RUN_CONTAINER_SMOKE !== "1")(
    "runs the installed agentctl through the real container boundary",
    async () => {
      const engine = process.env.CONTAINER_ENGINE ?? "docker";
      await execFileAsync(engine, ["image", "inspect", IMAGE], { timeout: 15_000 });

      const root = await mkdtemp(path.join(tmpdir(), "nawgate-container-smoke-"));
      temporaryDirectories.push(root);
      const store = new JsonStore(path.join(root, "db.json"));
      await store.initialize();
      const audit = new AuditService(store);
      const approvals = new ApprovalService(store, audit);
      const resources = new ProtectedResourceService(store);
      const credentials = new RuntimeCredentialService();
      const service = {
        getAgent: () => ({ id: AGENT_ID, ownerUserId: "user-a" }),
        getActiveRun: () => null,
        listAgents: () => [],
        systemInfo: async () => ({}),
      } as unknown as AgentService;
      const app = await createApp(
        loadConfig({ NODE_ENV: "test", RUNTIME_PROVIDER: "container" }),
        service,
        undefined,
        {
          credentials,
          approvals,
          audit,
          gateway: new RuntimeGateway(
            new DeterministicPolicyEngine(),
            resources,
            audit,
            approvals,
            store,
          ),
        },
      );
      applications.push(app);
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("Smoke server did not bind");
      const gatewayUrl = engine === "podman"
        ? `http://host.containers.internal:${address.port}`
        : `http://host.docker.internal:${address.port}`;
      const credential = credentials.issue(AGENT_ID, RUN_ID, "user-a");

      const run = async (...args: string[]) => execFileAsync(
        engine,
        [
          "run", "--rm", "--network", "bridge",
          ...(engine === "docker" ? ["--add-host", "host.docker.internal:host-gateway"] : []),
          "--env", "NAWGATE_RUNTIME_TOKEN",
          "--env", "NAWGATE_GATEWAY_URL",
          IMAGE,
          "agentctl",
          ...args,
        ],
        {
          env: {
            ...process.env,
            NAWGATE_RUNTIME_TOKEN: credential.token,
            NAWGATE_GATEWAY_URL: gatewayUrl,
            NAWGATE_APPROVAL_WAIT_MS: "1000",
          },
          timeout: 30_000,
        },
      );

      const allowed = await run("resource", "read", "project-a");
      expect(allowed.stdout).toContain("project-a");
      const denied = await run("resource", "read", "project-b").catch((error: { stdout?: string; stderr?: string; code?: number }) => error);
      expect(`${denied.stdout ?? ""}${denied.stderr ?? ""}`).toContain("not permitted");
      expect(resources.getExecutionCount("resource.read", "project-a")).toBe(1);
      expect(resources.getExecutionCount("resource.read", "project-b")).toBe(0);
      expect(credentials.activeCount()).toBe(1);
    },
  );
});

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  AGENTGATE_GATEWAY_URL: z.string().url().optional(),
  AGENTGATE_APPROVAL_WAIT_MS: z.coerce.number().int().min(1_000).default(90_000),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  MODEL_PROVIDER: z.enum(["ark", "openai-compatible"]).default("ark"),
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  OPENAI_BASE_URL: z
    .string()
    .url()
    .default("https://api.openai.com/v1"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  if (env.AGENTGATE_APPROVAL_WAIT_MS >= env.CODEX_TIMEOUT_MS) {
    throw new Error("AGENTGATE_APPROVAL_WAIT_MS must be shorter than CODEX_TIMEOUT_MS");
  }
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server",
      );
    }
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    agentGateGatewayUrl:
      env.AGENTGATE_GATEWAY_URL?.trim() || "http://127.0.0.1:" + env.PORT,
    agentGateApprovalWaitMs: env.AGENTGATE_APPROVAL_WAIT_MS,
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    modelProvider: env.MODEL_PROVIDER,
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel: env.ARK_MODEL?.trim() ?? "",
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    openaiApiKey: env.OPENAI_API_KEY?.trim() ?? "",
    openaiModel: env.OPENAI_MODEL?.trim() ?? "",
    openaiBaseUrl: env.OPENAI_BASE_URL.replace(/\/+$/, ""),
    modelApiKey:
      env.MODEL_PROVIDER === "openai-compatible"
        ? env.OPENAI_API_KEY?.trim() ?? ""
        : env.ARK_API_KEY?.trim() ?? "",
    modelName:
      env.MODEL_PROVIDER === "openai-compatible"
        ? env.OPENAI_MODEL?.trim() ?? ""
        : env.ARK_MODEL?.trim() ?? "",
    modelBaseUrl:
      env.MODEL_PROVIDER === "openai-compatible"
        ? env.OPENAI_BASE_URL.replace(/\/+$/, "")
        : env.ARK_BASE_URL.replace(/\/+$/, ""),
    modelApiKeyEnv: env.MODEL_PROVIDER === "openai-compatible" ? "OPENAI_API_KEY" : "ARK_API_KEY",
    nodeEnv: env.NODE_ENV,
  };
}

function isConfigured(apiKey: string, model: string): boolean {
  return (
    apiKey.length > 0 &&
    !apiKey.startsWith("replace-") &&
    model.length > 0 &&
    !model.includes("replace-")
  );
}

export function isModelConfigured(config: AppConfig): boolean {
  return isConfigured(config.modelApiKey, config.modelName);
}

export function isArkConfigured(config: AppConfig): boolean {
  return config.modelProvider === "ark" && isConfigured(config.arkApiKey, config.arkModel);
}

export async function writeCodexConfig(config: AppConfig): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });
  const providerId = config.modelProvider === "ark" ? "volcengine_ark" : "openai_compatible";
  const providerName = config.modelProvider === "ark" ? "Volcengine Ark" : "OpenAI-compatible";
  const toml = [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.modelName || "model-not-configured"),
    `model_provider = ${JSON.stringify(providerId)}`,
    "",
    `[model_providers.${providerId}]`,
    "name = " + JSON.stringify(providerName),
    "base_url = " + JSON.stringify(config.modelBaseUrl),
    `env_key = ${JSON.stringify(config.modelApiKeyEnv)}`,
    'wire_api = "responses"',
    `requires_openai_auth = ${config.modelProvider === "ark" ? "false" : "true"}`,
    "",
  ].join("\n");
  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}

import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { isModelConfigured, loadConfig, writeCodexConfig } from "./config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("model provider configuration", () => {
  it("keeps the Security Lab disabled unless explicitly set to true", () => {
    expect(loadConfig({ NODE_ENV: "test" }).securityLabEnabled).toBe(false);
    expect(
      loadConfig({ NODE_ENV: "test", NAWGATE_SECURITY_LAB_ENABLED: "true" })
        .securityLabEnabled,
    ).toBe(true);
    expect(
      loadConfig({ NODE_ENV: "test", NAWGATE_SECURITY_LAB_ENABLED: "false" })
        .securityLabEnabled,
    ).toBe(false);
    expect(() =>
      loadConfig({ NODE_ENV: "test", NAWGATE_SECURITY_LAB_ENABLED: "yes" }),
    ).toThrow();
  });

  it("preserves the Ark configuration path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-config-test-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "ark-test-key",
      ARK_MODEL: "ep-test",
      CODEX_HOME: root,
    });

    expect(config.modelProvider).toBe("ark");
    expect(config.modelApiKeyEnv).toBe("ARK_API_KEY");
    expect(isModelConfigured(config)).toBe(true);
    await writeCodexConfig(config);
    const codexConfig = await readFile(path.join(root, "config.toml"), "utf8");
    expect(codexConfig).toContain('model_provider = "volcengine_ark"');
    expect(codexConfig).toContain('env_key = "ARK_API_KEY"');
  });

  it("writes an OpenAI-compatible Responses provider", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-config-test-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      MODEL_PROVIDER: "openai-compatible",
      OPENAI_API_KEY: "openai-test-key",
      OPENAI_MODEL: "gpt-5",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      CODEX_HOME: root,
    });

    expect(config.modelProvider).toBe("openai-compatible");
    expect(config.modelApiKeyEnv).toBe("OPENAI_API_KEY");
    expect(config.modelBaseUrl).toBe("https://api.openai.com/v1");
    expect(isModelConfigured(config)).toBe(true);
    await writeCodexConfig(config);
    const codexConfig = await readFile(path.join(root, "config.toml"), "utf8");
    expect(codexConfig).toContain('model_provider = "openai_compatible"');
    expect(codexConfig).toContain('base_url = "https://api.openai.com/v1"');
    expect(codexConfig).toContain('env_key = "OPENAI_API_KEY"');
    expect(codexConfig).toContain('wire_api = "responses"');
    expect(codexConfig).toContain("requires_openai_auth = true");
  });

  it("does not consider placeholder provider credentials configured", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      MODEL_PROVIDER: "openai-compatible",
      OPENAI_API_KEY: "replace-with-key",
      OPENAI_MODEL: "gpt-5",
    });
    expect(isModelConfigured(config)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const noHumanSession = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(noHumanSession.statusCode).toBe(401);

    const session = await app.inject({
      method: "POST",
      url: "/api/demo/session",
      headers: { authorization: "Bearer a-strong-test-token" },
      payload: { userId: "user-a" },
    });
    expect(session.statusCode).toBe(200);
    const { sessionToken } = session.json() as { sessionToken: string };
    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: {
        authorization: "Bearer a-strong-test-token",
        "x-agentgate-session": sessionToken,
      },
    });
    expect(allowed.statusCode).toBe(200);
    const me = await app.inject({
      method: "GET",
      url: "/api/demo/me",
      headers: {
        authorization: "Bearer a-strong-test-token",
        "x-agentgate-session": sessionToken,
      },
    });
    expect(me.json()).toEqual({ user: { id: "user-a", name: "User A" } });
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const forgedOwner = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: { name: "forged", ownerUserId: "user-b" },
    });
    expect(forgedOwner.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });
});

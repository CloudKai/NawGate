import { describe, expect, it } from "vitest";
import {
  RuntimeAuthorityRevokedError,
  RuntimeCredentialService,
} from "./runtime-credential-service.js";

describe("RuntimeCredentialService", () => {
  it("issues an exact Run credential and resolves its trusted context", () => {
    const credentials = new RuntimeCredentialService(() => 1_000, 10_000);
    const issued = credentials.issue("agent-a", "run-a", "user-a");

    expect(issued.token).toHaveLength(43);
    expect(credentials.resolve(issued.token)).toMatchObject({
      status: "valid",
      context: { agentId: "agent-a", runId: "run-a", humanId: "user-a" },
    });
    expect(credentials.resolve("random-runtime-token")).toEqual({ status: "invalid" });
    expect(JSON.stringify(credentials)).not.toContain(issued.token);
  });

  it("rejects expired and revoked credentials", () => {
    let current = 1_000;
    const credentials = new RuntimeCredentialService(() => current, 100);
    const expired = credentials.issue("agent-a", "run-expired", "user-a");
    current = 1_100;
    expect(credentials.resolve(expired.token)).toEqual({ status: "expired" });

    const active = credentials.issue("agent-a", "run-active", "user-a");
    credentials.revoke("run-active");
    expect(credentials.resolve(active.token)).toEqual({ status: "invalid" });
    expect(credentials.activeCount()).toBe(0);
  });

  it("revokes Run authority and prevents a queued runner from minting again", () => {
    const credentials = new RuntimeCredentialService(() => 1_000, 10_000);
    const issued = credentials.issue("agent-a", "run-revoked", "user-a");

    credentials.revokeAuthority("run-revoked");

    expect(credentials.isAuthorityRevoked("run-revoked")).toBe(true);
    expect(credentials.resolve(issued.token)).toEqual({ status: "invalid" });
    expect(() => credentials.issue("agent-a", "run-revoked", "user-a")).toThrow(
      RuntimeAuthorityRevokedError,
    );
  });
});

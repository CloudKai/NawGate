import { describe, expect, it } from "vitest";
import { IdentityService } from "./identity-service.js";

describe("IdentityService", () => {
  it("issues an opaque session for a fixed demo principal", () => {
    const identity = new IdentityService(() => 1_000, 10_000);
    const session = identity.createSession("user-a");

    expect(session.user).toEqual({ id: "user-a", name: "User A" });
    expect(session.sessionToken).toHaveLength(43);
    expect(identity.resolveSession(session.sessionToken)).toEqual(session.user);
    expect(identity.resolveSession("TEST_HUMAN_SESSION_DO_NOT_LOG")).toBeNull();
  });

  it("rejects unknown and expired sessions", () => {
    let currentTime = 1_000;
    const identity = new IdentityService(() => currentTime, 10_000);

    expect(() => identity.createSession("unknown-user")).toThrowError("Unknown demo user");
    expect(identity.resolveSession("random-token")).toBeNull();

    const session = identity.createSession("user-b");
    currentTime = 11_000;
    expect(identity.resolveSession(session.sessionToken)).toBeNull();
    expect(() => identity.requireSession(session.sessionToken)).toThrowError(
      "Human session required",
    );
  });
});

import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "../errors.js";
import { DEMO_USERS, getDemoUser } from "./demo-users.js";
import type { HumanPrincipal } from "./types.js";

interface SessionRecord {
  principal: HumanPrincipal;
  expiresAt: number;
}

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1_000;

export interface DemoSession {
  sessionToken: string;
  user: HumanPrincipal;
  expiresAt: string;
}

export class IdentityService {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  ) {}

  listUsers(): HumanPrincipal[] {
    return DEMO_USERS.map((user) => ({ ...user }));
  }

  createSession(userId: string): DemoSession {
    const principal = getDemoUser(userId);
    if (!principal) {
      throw new HttpError(400, "Unknown demo user");
    }
    const expiresAt = this.now() + this.sessionTtlMs;
    const sessionToken = randomBytes(32).toString("base64url");
    this.sessions.set(this.hash(sessionToken), { principal, expiresAt });
    return {
      sessionToken,
      user: { ...principal },
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  resolveSession(sessionToken: string | undefined): HumanPrincipal | null {
    if (!sessionToken?.trim()) return null;
    const sessionHash = this.hash(sessionToken.trim());
    const session = this.sessions.get(sessionHash);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(sessionHash);
      return null;
    }
    return { ...session.principal };
  }

  requireSession(sessionToken: string | undefined): HumanPrincipal {
    const principal = this.resolveSession(sessionToken);
    if (!principal) {
      throw new HttpError(401, "Human session required");
    }
    return principal;
  }

  private hash(token: string): string {
    return createHash("sha256").update(token).digest("base64url");
  }
}

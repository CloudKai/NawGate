import { createHash, randomBytes } from "node:crypto";
import { isHumanId } from "./demo-users.js";
import type { HumanId, TrustedRuntimeContext } from "./types.js";

const DEFAULT_RUNTIME_TTL_MS = 10 * 60 * 1_000;

interface CredentialRecord {
  context: TrustedRuntimeContext;
  issuedAt: number;
  expiresAt: number;
}

export interface IssuedRuntimeCredential {
  token: string;
  context: TrustedRuntimeContext;
  issuedAt: string;
  expiresAt: string;
}

export type RuntimeCredentialResolution =
  | {
      status: "valid";
      context: TrustedRuntimeContext;
      issuedAt: string;
      expiresAt: string;
    }
  | { status: "invalid" | "expired" | "revoked" };

export class RuntimeCredentialService {
  private readonly credentials = new Map<string, CredentialRecord>();
  private readonly revokedRunIds = new Set<string>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = DEFAULT_RUNTIME_TTL_MS,
  ) {}

  issue(
    agentId: string,
    runId: string,
    ownerUserId: HumanId,
  ): IssuedRuntimeCredential {
    if (this.revokedRunIds.has(runId)) {
      throw new RuntimeAuthorityRevokedError(runId);
    }
    const issuedAt = this.now();
    const expiresAt = issuedAt + this.ttlMs;
    const context: TrustedRuntimeContext = { agentId, runId, humanId: ownerUserId };
    const token = randomBytes(32).toString("base64url");
    this.credentials.set(this.hash(token), { context, issuedAt, expiresAt });
    return {
      token,
      context: { ...context },
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  resolve(token: string | undefined): RuntimeCredentialResolution {
    if (!token?.trim()) return { status: "invalid" };
    const hash = this.hash(token.trim());
    const record = this.credentials.get(hash);
    if (!record) return { status: "invalid" };
    if (record.expiresAt <= this.now()) {
      this.credentials.delete(hash);
      return { status: "expired" };
    }
    return {
      status: "valid",
      context: { ...record.context },
      issuedAt: new Date(record.issuedAt).toISOString(),
      expiresAt: new Date(record.expiresAt).toISOString(),
    };
  }

  revoke(runId: string): void {
    for (const [hash, record] of this.credentials) {
      if (record.context.runId === runId) this.credentials.delete(hash);
    }
  }

  /**
   * Explicitly revoke the Run's authority. This is intentionally separate
   * from normal lifecycle cleanup: a queued runner must not be able to mint a
   * fresh credential after an owner has revoked access.
   */
  revokeAuthority(runId: string): void {
    this.revokedRunIds.add(runId);
    this.revoke(runId);
  }

  isAuthorityRevoked(runId: string): boolean {
    return this.revokedRunIds.has(runId);
  }

  isAuthorityActive(context: TrustedRuntimeContext): boolean {
    if (this.revokedRunIds.has(context.runId)) return false;
    for (const record of this.credentials.values()) {
      if (
        record.context.runId === context.runId &&
        record.context.agentId === context.agentId &&
        record.context.humanId === context.humanId &&
        record.expiresAt > this.now()
      ) {
        return true;
      }
    }
    return false;
  }

  activeCount(): number {
    return this.credentials.size;
  }

  private hash(token: string): string {
    return createHash("sha256").update(token).digest("base64url");
  }
}

export class RuntimeAuthorityRevokedError extends Error {
  constructor(runId: string) {
    super(`Runtime authority revoked for Run ${runId}`);
    this.name = "RuntimeAuthorityRevokedError";
  }
}

export function isRuntimeContext(value: unknown): value is TrustedRuntimeContext {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.humanId === "string" &&
    isHumanId(candidate.humanId) &&
    typeof candidate.agentId === "string" &&
    candidate.agentId.length > 0 &&
    typeof candidate.runId === "string" &&
    candidate.runId.length > 0
  );
}

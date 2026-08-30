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

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = DEFAULT_RUNTIME_TTL_MS,
  ) {}

  issue(
    agentId: string,
    runId: string,
    ownerUserId: HumanId,
  ): IssuedRuntimeCredential {
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

  activeCount(): number {
    return this.credentials.size;
  }

  private hash(token: string): string {
    return createHash("sha256").update(token).digest("base64url");
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

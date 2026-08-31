import { createHash } from "node:crypto";

/**
 * Canonical JSON is deliberately small and dependency-free for the MVP:
 * objects are encoded with lexicographically sorted keys, arrays preserve
 * order, and only JSON values with finite numbers are accepted. The helper is
 * used for request binding only; the original payload is never persisted.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Payload contains a non-finite number");
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Payload number is not JSON-encodable");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Payload must contain plain JSON objects");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Payload contains a non-JSON value");
}

export function canonicalPayloadDigest(payload: unknown): string {
  // Missing payload and an explicit JSON null represent the same empty
  // payload. This keeps the wire contract backwards-compatible while still
  // binding every approval to a digest.
  const canonical = canonicalJson(payload === undefined ? null : payload);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

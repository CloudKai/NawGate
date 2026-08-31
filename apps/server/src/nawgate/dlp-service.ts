const SECRET_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  // OpenAI API keys
  { pattern: /\bsk-[a-zA-Z0-9_-]{20,}\b/g, replacement: "[REDACTED_OPENAI_KEY]" },
  // Volcengine Ark API keys
  { pattern: /\bark-[a-zA-Z0-9_-]{20,}\b/g, replacement: "[REDACTED_ARK_KEY]" },
  // Bearer authentication tokens
  { pattern: /bearer\s+[a-zA-Z0-9_.\-]+/gi, replacement: "Bearer [REDACTED_TOKEN]" },
  // Private Key blocks (PEM)
  {
    pattern: /-----BEGIN[ A-Z_-]+PRIVATE KEY-----[\s\S]*?-----END[ A-Z_-]+PRIVATE KEY-----/gi,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  // Credit Card Numbers (Visa: 4..., Mastercard: 51-55..., Amex: 34/37..., Discover: 6011...)
  {
    pattern: /\b(?:4\d{3}|5[1-5]\d{2}|6011|3[47]\d{2})[- ]?\d{4}[- ]?\d{4}[- ]?\d{3,4}\b/g,
    replacement: "[REDACTED_CC]",
  },
  {
    pattern: /\b(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|6011\d{12}|3[47]\d{13})\b/g,
    replacement: "[REDACTED_CC]",
  },
  // Email Addresses
  { pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, replacement: "[REDACTED_EMAIL]" },
  // Generic Token/Secret assignments
  {
    pattern: /\b(api[_-]?key|secret|token|password)\s*[:=]\s*["']?[a-zA-Z0-9_\-]{16,}["']?/gi,
    replacement: "$1: [REDACTED_SECRET]",
  },
];

const PRESERVED_IDENTIFIER_KEYS = new Set([
  "id",
  "runId",
  "agentId",
  "humanId",
  "ownerUserId",
  "requestId",
  "approvalId",
  "capabilityId",
  "status",
  "eventType",
  "action",
  "resourceId",
  "policyVersion",
  "enforcementPoint",
  "startedAt",
  "completedAt",
  "createdAt",
  "updatedAt",
]);

/**
 * Mask sensitive patterns (API keys, tokens, credentials, emails, CC numbers) in string data.
 */
export function maskSensitiveData(text: string | null | undefined): string {
  if (!text) return "";
  let cleaned = text;
  for (const item of SECRET_PATTERNS) {
    cleaned = cleaned.replace(item.pattern, item.replacement);
  }
  return cleaned;
}

/**
 * Deep-traverse any JSON-compatible object or primitive, masking all string values while preserving structural IDs.
 */
export function maskObject<T>(value: T, currentKey?: string): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    if (currentKey && PRESERVED_IDENTIFIER_KEYS.has(currentKey)) {
      return value;
    }
    return maskSensitiveData(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskObject(item)) as unknown as T;
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = maskObject(val, key);
    }
    return result as T;
  }
  return value;
}

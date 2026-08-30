import { describe, expect, it } from "vitest";
import { maskObject, maskSensitiveData } from "./dlp-service.js";

describe("DLP Service (Data Loss Prevention)", () => {
  describe("maskSensitiveData", () => {
    it("handles null, undefined, and empty string safely", () => {
      expect(maskSensitiveData(null)).toBe("");
      expect(maskSensitiveData(undefined)).toBe("");
      expect(maskSensitiveData("")).toBe("");
    });

    it("redacts OpenAI API keys", () => {
      const input = "Using key sk-abcdef1234567890abcdef1234567890 to call OpenAI";
      expect(maskSensitiveData(input)).toBe("Using key [REDACTED_OPENAI_KEY] to call OpenAI");
    });

    it("redacts Volcengine Ark API keys", () => {
      const input = "ark-0123456789abcdef0123456789 is configured for Ark endpoint";
      expect(maskSensitiveData(input)).toBe("[REDACTED_ARK_KEY] is configured for Ark endpoint");
    });

    it("redacts Bearer tokens", () => {
      const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
      expect(maskSensitiveData(input)).toBe("Authorization: Bearer [REDACTED_TOKEN]");
    });

    it("redacts credit card numbers", () => {
      const input1 = "Card number is 4111-2222-3333-4444 on file.";
      const input2 = "Space separated 4111 2222 3333 4444 card.";
      expect(maskSensitiveData(input1)).toBe("Card number is [REDACTED_CC] on file.");
      expect(maskSensitiveData(input2)).toBe("Space separated [REDACTED_CC] card.");
    });

    it("redacts email addresses", () => {
      const input = "Please reach out to developer.admin@company.org or security@launchpad.io";
      expect(maskSensitiveData(input)).toBe(
        "Please reach out to [REDACTED_EMAIL] or [REDACTED_EMAIL]",
      );
    });

    it("redacts PEM private key blocks", () => {
      const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y3y...
-----END RSA PRIVATE KEY-----`;
      expect(maskSensitiveData(pem)).toBe("[REDACTED_PRIVATE_KEY]");
    });

    it("leaves regular non-sensitive text untouched", () => {
      const normal = "Deploy the web app to staging environment on port 3000.";
      expect(maskSensitiveData(normal)).toBe(normal);
    });
  });

  describe("maskObject", () => {
    it("recursively sanitizes strings in nested objects and arrays", () => {
      const payload = {
        agentId: "agent-1",
        meta: {
          token: "Bearer secret-session-token-12345",
          email: "user@example.com",
        },
        items: [
          "Normal item",
          "sk-123456789012345678901234567890",
          { key: "ark-987654321098765432109876543210" },
        ],
        numeric: 42,
        boolean: true,
        empty: null,
      };

      const sanitized = maskObject(payload);
      expect(sanitized).toEqual({
        agentId: "agent-1",
        meta: {
          token: "Bearer [REDACTED_TOKEN]",
          email: "[REDACTED_EMAIL]",
        },
        items: [
          "Normal item",
          "[REDACTED_OPENAI_KEY]",
          { key: "[REDACTED_ARK_KEY]" },
        ],
        numeric: 42,
        boolean: true,
        empty: null,
      });
    });
  });
});

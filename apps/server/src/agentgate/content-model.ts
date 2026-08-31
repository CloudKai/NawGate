import type {
  ContentAction,
  ContentActionBinding,
  ContentPurpose,
  ContentScopeGrant,
  HumanId,
} from "./types.js";

export const CONTENT_PURPOSES: readonly ContentPurpose[] = [
  "safety_moderation",
  "creator_requested_publish",
  "approved_analytics",
  "compliance_archive",
];

export const CONTENT_ACTIONS: readonly ContentAction[] = [
  "content.moderate",
  "content.disclose",
  "content.publish",
  "content.export",
];

export const CONTENT_DESTINATIONS = {
  analytics: "analytics:account-user-a",
  analyticsUserB: "analytics:account-user-b",
  publishUserA: "tiktok:publish:account-user-a",
  publishUserB: "tiktok:publish:account-user-b",
  archiveUserA: "compliance:archive:org-user-a",
  archiveUserB: "compliance:archive:org-user-b",
} as const;

const payloadKeys = [
  "purpose",
  "organizationId",
  "businessCenterId",
  "accountId",
  "assetId",
  "contentVersion",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160;
}

export function isContentAction(value: string): value is ContentAction {
  return CONTENT_ACTIONS.includes(value as ContentAction);
}

export function isContentPurpose(value: unknown): value is ContentPurpose {
  return typeof value === "string" && CONTENT_PURPOSES.includes(value as ContentPurpose);
}

export function parseContentActionBinding(payload: unknown): ContentActionBinding | null {
  if (!isRecord(payload)) return null;
  const keys = Object.keys(payload).sort();
  if (keys.length !== payloadKeys.length || !payloadKeys.every((key) => keys.includes(key))) {
    return null;
  }
  if (
    !isContentPurpose(payload.purpose) ||
    !isNonEmptyString(payload.organizationId) ||
    !isNonEmptyString(payload.businessCenterId) ||
    !isNonEmptyString(payload.accountId) ||
    !isNonEmptyString(payload.assetId) ||
    !isNonEmptyString(payload.contentVersion)
  ) {
    return null;
  }
  return {
    purpose: payload.purpose,
    organizationId: payload.organizationId,
    businessCenterId: payload.businessCenterId,
    accountId: payload.accountId,
    assetId: payload.assetId,
    contentVersion: payload.contentVersion,
  };
}

export function expectedContentDestination(
  action: ContentAction,
  accountId: string,
  organizationId: string,
): string | null {
  if (action === "content.publish") {
    if (accountId === "account-user-a") return CONTENT_DESTINATIONS.publishUserA;
    if (accountId === "account-user-b") return CONTENT_DESTINATIONS.publishUserB;
    return null;
  }
  if (action === "content.disclose") {
    if (accountId === "account-user-a") return CONTENT_DESTINATIONS.analytics;
    if (accountId === "account-user-b") return CONTENT_DESTINATIONS.analyticsUserB;
    return null;
  }
  if (action === "content.export") {
    if (organizationId === "org-user-a") return CONTENT_DESTINATIONS.archiveUserA;
    if (organizationId === "org-user-b") return CONTENT_DESTINATIONS.archiveUserB;
    return null;
  }
  return null;
}

export function isKnownContentDestination(value: unknown): value is string {
  return Object.values(CONTENT_DESTINATIONS).includes(value as (typeof CONTENT_DESTINATIONS)[keyof typeof CONTENT_DESTINATIONS]);
}

export function demoContentScopes(humanId: HumanId): ContentScopeGrant[] {
  if (humanId === "user-a") {
    return [{
      id: "content-scope-user-a-approved-analytics",
      humanId,
      organizationId: "org-user-a",
      businessCenterId: "business-center-user-a",
      accountId: "account-user-a",
      assetIds: ["asset-user-a-video-1"],
      allowedActions: ["content.disclose"],
      allowedPurposes: ["approved_analytics"],
      destinations: [CONTENT_DESTINATIONS.analytics],
    }];
  }
  return [{
    id: "content-scope-user-b-approved-analytics",
    humanId,
    organizationId: "org-user-b",
    businessCenterId: "business-center-user-b",
    accountId: "account-user-b",
    assetIds: ["asset-user-b-video-1"],
    allowedActions: ["content.disclose"],
    allowedPurposes: ["approved_analytics"],
    destinations: [CONTENT_DESTINATIONS.analyticsUserB],
  }];
}

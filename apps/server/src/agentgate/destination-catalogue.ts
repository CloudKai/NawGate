import { CONTENT_ACTIONS, CONTENT_DESTINATIONS, CONTENT_PURPOSES } from "./content-model.js";
import type {
  ContentPurpose,
  DestinationSideEffectReceipt,
  RegisteredDestination,
  RegisteredDestinationId,
} from "./types.js";
import type { JsonStore } from "../store.js";

export const REGISTERED_DESTINATION_IDS: readonly RegisteredDestinationId[] = [
  "tiktok-account:brand-sg",
  "tiktok-account:creator-demo",
  "analytics:approved-dashboard",
  "archive:compliance-store",
];

export const DEMO_REGISTERED_DESTINATIONS: readonly RegisteredDestination[] = [
  {
    id: CONTENT_DESTINATIONS.publishUserA,
    organizationId: "org-user-a",
    businessCenterId: "business-center-user-a",
    accountId: "account-user-a",
    allowedActions: ["content.publish"],
    httpMethod: "POST",
    httpsHost: "tiktok.local.test",
    httpsPathPattern: "/v1/accounts/:accountId/content/:assetId",
    environment: "local",
    status: "enabled",
    revision: 1,
    credentialRef: "credential-ref:tiktok:brand-sg",
    classification: "restricted",
    purposes: ["creator_requested_publish"],
    audience: "external",
    reach: "broad",
    region: "SG",
  },
  {
    id: CONTENT_DESTINATIONS.publishUserB,
    organizationId: "org-user-b",
    businessCenterId: "business-center-user-b",
    accountId: "account-user-b",
    allowedActions: ["content.publish"],
    httpMethod: "POST",
    httpsHost: "tiktok.local.test",
    httpsPathPattern: "/v1/accounts/:accountId/content/:assetId",
    environment: "local",
    status: "enabled",
    revision: 1,
    credentialRef: "credential-ref:tiktok:creator-demo",
    classification: "restricted",
    purposes: ["creator_requested_publish"],
    audience: "external",
    reach: "broad",
    region: "SG",
  },
  {
    id: CONTENT_DESTINATIONS.analytics,
    organizationId: "org-user-a",
    businessCenterId: "business-center-user-a",
    accountId: "account-user-a",
    allowedActions: ["content.disclose"],
    httpMethod: "POST",
    httpsHost: "analytics.local.test",
    httpsPathPattern: "/v1/accounts/:accountId/approved-content/:assetId",
    environment: "local",
    status: "enabled",
    revision: 1,
    credentialRef: "credential-ref:analytics:approved-dashboard",
    classification: "sensitive",
    purposes: ["approved_analytics"],
    audience: "team",
    reach: "narrow",
    region: "SG",
  },
  {
    id: "archive:compliance-store",
    organizationId: "org-user-a",
    businessCenterId: "business-center-user-a",
    accountId: "account-user-a",
    allowedActions: ["content.export"],
    httpMethod: "POST",
    httpsHost: "archive.local.test",
    httpsPathPattern: "/v1/organizations/:organizationId/archive/:assetId",
    environment: "local",
    status: "enabled",
    revision: 1,
    credentialRef: "credential-ref:archive:compliance-store",
    classification: "restricted",
    purposes: ["compliance_archive"],
    audience: "team",
    reach: "narrow",
    region: "SG",
  },
];

const knownDestinationIds = new Set<string>(REGISTERED_DESTINATION_IDS);
const knownActions = new Set<string>(CONTENT_ACTIONS);
const knownPurposes = new Set<ContentPurpose>(CONTENT_PURPOSES);
const knownEnvironments = new Set(["local", "staging", "production"]);
const destinationKeys = [
  "id", "organizationId", "businessCenterId", "accountId", "allowedActions",
  "httpMethod", "httpsHost", "httpsPathPattern", "environment", "status",
  "revision", "credentialRef", "classification", "purposes",
  "audience", "reach", "region",
].sort();
const receiptKeys = [
  "id", "destinationId", "action", "resourceId", "purpose", "httpMethod",
  "httpsHost", "httpsPath", "environment", "destinationRevision",
  "resourceRevision", "credentialRef", "createdAt",
].sort();

function isSafeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 160 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

function isSafeHost(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 253 &&
    value === value.trim() &&
    /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/.test(value)
  );
}

function isSafePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    !value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("..") ||
    /\s/.test(value)
  ) {
    return false;
  }
  const placeholders = [...value.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]);
  return placeholders.every((placeholder) =>
    placeholder === "accountId" || placeholder === "organizationId" || placeholder === "assetId",
  );
}

function isSafeCredentialRef(value: unknown): value is string {
  return typeof value === "string" && /^credential-ref:[a-z0-9]+(?::[a-z0-9-]+)+$/.test(value);
}

export function isRegisteredDestinationId(value: unknown): value is RegisteredDestinationId {
  return typeof value === "string" && knownDestinationIds.has(value);
}

export function isRegisteredDestination(value: unknown): value is RegisteredDestination {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(destinationKeys)) {
    return false;
  }
  return (
    isRegisteredDestinationId(record.id) &&
    isSafeIdentifier(record.organizationId) &&
    isSafeIdentifier(record.businessCenterId) &&
    isSafeIdentifier(record.accountId) &&
    Array.isArray(record.allowedActions) && record.allowedActions.length > 0 &&
    new Set(record.allowedActions).size === record.allowedActions.length &&
    record.allowedActions.every((action) => typeof action === "string" && knownActions.has(action)) &&
    record.httpMethod === "POST" &&
    isSafeHost(record.httpsHost) &&
    isSafePath(record.httpsPathPattern) &&
    typeof record.environment === "string" && knownEnvironments.has(record.environment) &&
    (record.status === "enabled" || record.status === "disabled" || record.status === "revoked") &&
    typeof record.revision === "number" && Number.isInteger(record.revision) && record.revision > 0 &&
    isSafeCredentialRef(record.credentialRef) &&
    (record.classification === "internal" || record.classification === "sensitive" || record.classification === "restricted") &&
    Array.isArray(record.purposes) && record.purposes.length > 0 &&
    new Set(record.purposes).size === record.purposes.length &&
    record.purposes.every((purpose) => typeof purpose === "string" && knownPurposes.has(purpose as ContentPurpose)) &&
    (record.audience === "owner" || record.audience === "team" || record.audience === "external") &&
    (record.reach === "narrow" || record.reach === "broad") &&
    (record.region === "SG" || record.region === "GLOBAL")
  );
}

export function isDestinationSideEffectReceipt(
  value: unknown,
): value is DestinationSideEffectReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(receiptKeys)) {
    return false;
  }
  return (
    typeof record.id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.id) &&
    isRegisteredDestinationId(record.destinationId) &&
    typeof record.action === "string" && knownActions.has(record.action) &&
    isSafeIdentifier(record.resourceId) &&
    typeof record.purpose === "string" && knownPurposes.has(record.purpose as ContentPurpose) &&
    record.httpMethod === "POST" &&
    isSafeHost(record.httpsHost) &&
    isSafePath(record.httpsPath) &&
    typeof record.environment === "string" && knownEnvironments.has(record.environment) &&
    typeof record.destinationRevision === "number" &&
    Number.isInteger(record.destinationRevision) && record.destinationRevision > 0 &&
    typeof record.resourceRevision === "number" &&
    Number.isInteger(record.resourceRevision) && record.resourceRevision > 0 &&
    isSafeCredentialRef(record.credentialRef) &&
    typeof record.createdAt === "string" && Number.isFinite(Date.parse(record.createdAt))
  );
}

export function materializeDestinationPath(
  destination: RegisteredDestination,
  values: { accountId: string; organizationId: string; assetId: string },
): string {
  return destination.httpsPathPattern
    .replaceAll(":accountId", encodeURIComponent(values.accountId))
    .replaceAll(":organizationId", encodeURIComponent(values.organizationId))
    .replaceAll(":assetId", encodeURIComponent(values.assetId));
}

export interface DestinationClaimInvalidator {
  revokeForDestination(destinationId: RegisteredDestinationId, reasonCode?: string): Promise<unknown>;
}

export class DestinationCatalogueService {
  constructor(
    private readonly store: JsonStore,
    private readonly claims?: DestinationClaimInvalidator,
  ) {}

  get(destinationId: string): RegisteredDestination | null {
    const destination = this.store
      .snapshot()
      .registeredDestinations.find(
        (candidate) => candidate.id === destinationId && isRegisteredDestination(candidate),
      );
    return destination ? structuredClone(destination) : null;
  }

  list(): RegisteredDestination[] {
    return this.store
      .snapshot()
      .registeredDestinations
      .filter(isRegisteredDestination)
      .map((destination) => structuredClone(destination));
  }

  async bumpRevision(
    destinationId: RegisteredDestinationId,
    reasonCode = "destination_revision_changed",
  ): Promise<RegisteredDestination> {
    const destination = await this.store.mutate((database) => {
      const current = database.registeredDestinations.find((candidate) => candidate.id === destinationId);
      if (!current) throw new Error("Registered destination not found");
      current.revision += 1;
      return structuredClone(current);
    });
    await this.claims?.revokeForDestination(destinationId, reasonCode);
    return destination;
  }

  async revoke(
    destinationId: RegisteredDestinationId,
    reasonCode = "content_destination_revoked",
  ): Promise<RegisteredDestination> {
    const destination = await this.store.mutate((database) => {
      const current = database.registeredDestinations.find((candidate) => candidate.id === destinationId);
      if (!current) throw new Error("Registered destination not found");
      current.status = "revoked";
      current.revision += 1;
      return structuredClone(current);
    });
    await this.claims?.revokeForDestination(destinationId, reasonCode);
    return destination;
  }

  async disable(
    destinationId: RegisteredDestinationId,
    reasonCode = "content_destination_disabled",
  ): Promise<RegisteredDestination> {
    const destination = await this.store.mutate((database) => {
      const current = database.registeredDestinations.find((candidate) => candidate.id === destinationId);
      if (!current) throw new Error("Registered destination not found");
      current.status = "disabled";
      current.revision += 1;
      return structuredClone(current);
    });
    await this.claims?.revokeForDestination(destinationId, reasonCode);
    return destination;
  }
}

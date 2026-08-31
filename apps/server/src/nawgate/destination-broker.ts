import { isRegisteredDestination } from "./destination-catalogue.js";
import type { RegisteredDestination } from "./types.js";

export class DestinationBrokerError extends Error {}

type CredentialCallback<T> = (credential: string) => Promise<T> | T;

// These values are synthetic test credentials, not provider credentials. They
// exist only in this process and are never returned by the broker.
const syntheticCredentials = new Map<string, string>([
  ["credential-ref:tiktok:brand-sg", "SYNTHETIC_DESTINATION_SECRET_CANARY_BRAND_SG"],
  ["credential-ref:tiktok:creator-demo", "SYNTHETIC_DESTINATION_SECRET_CANARY_CREATOR_DEMO"],
  ["credential-ref:analytics:approved-dashboard", "SYNTHETIC_DESTINATION_SECRET_CANARY_ANALYTICS"],
  ["credential-ref:archive:compliance-store", "SYNTHETIC_DESTINATION_SECRET_CANARY_ARCHIVE"],
]);

export class ServerSideCredentialBroker {
  constructor(
    private readonly credentials: ReadonlyMap<string, string> = syntheticCredentials,
  ) {}

  async withCredential<T>(
    destination: RegisteredDestination,
    callback: CredentialCallback<T>,
  ): Promise<T> {
    if (!isRegisteredDestination(destination) || destination.status !== "enabled") {
      throw new DestinationBrokerError("Destination credential unavailable");
    }
    const credential = this.credentials.get(destination.credentialRef);
    if (!credential) throw new DestinationBrokerError("Destination credential unavailable");
    // The credential is scoped to this callback. Callers receive no lease,
    // record, response, or error containing its value.
    return callback(credential);
  }
}

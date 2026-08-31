import { randomUUID } from "node:crypto";
import {
  DestinationCatalogueService,
  isRegisteredDestination,
  materializeDestinationPath,
} from "./destination-catalogue.js";
import { ServerSideCredentialBroker } from "./destination-broker.js";
import type {
  ActionExecutionRecord,
  ApprovalAuthorityRole,
  ApprovalDecision,
  ContentAction,
  ContentAssetResource,
  ContentPurpose,
  DestinationSideEffectReceipt,
  RegisteredDestination,
  RegisteredDestinationId,
  HumanId,
  RiskTier,
} from "./types.js";
import type { JsonStore } from "../store.js";
import type { Database } from "../types.js";

export interface ContentDestinationExecution {
  action: ContentAction;
  resource: ContentAssetResource;
  purpose: ContentPurpose;
  destinationId: RegisteredDestinationId;
  destinationRevision: number;
  resourceRevision: number;
  execution?: {
    runId: string;
    requestId: string;
    payloadDigest: string;
    destination: string | null;
    policyRevision: string;
    finalRecheck?: (database: Database) => void | Promise<void>;
    requesterHumanId?: HumanId;
    organizationId?: string;
    accountId?: string | null;
    risk?: RiskTier;
    riskVersion?: string;
    riskFactsDigest?: string;
    requiredApprovalCount?: number | null;
    requiredApprovalRoles?: ApprovalAuthorityRole[] | null;
    approvalDecisions?: ApprovalDecision[] | null;
  };
}

export interface ContentDestinationExecutor {
  execute(operation: ContentDestinationExecution): Promise<DestinationSideEffectReceipt>;
}

export class LocalDestinationAdapterError extends Error {}

/**
 * A deterministic local adapter. It models the downstream request and stores
 * only a safe receipt; it does not make a network call or claim network
 * isolation.
 */
export class LocalDestinationAdapter implements ContentDestinationExecutor {
  constructor(
    private readonly store: JsonStore,
    private readonly catalogue: DestinationCatalogueService,
    private readonly broker: ServerSideCredentialBroker,
  ) {}

  async execute(operation: ContentDestinationExecution): Promise<DestinationSideEffectReceipt> {
    const destination = this.catalogue.get(operation.destinationId);
    if (!destination) throw new LocalDestinationAdapterError("Registered destination not found");
    this.assertDestinationBinding(destination, operation);
    if (!isRegisteredDestination(destination)) {
      throw new LocalDestinationAdapterError("Registered destination metadata is invalid");
    }
    return this.store.mutate(async (database) => {
      const currentDestination = database.registeredDestinations.find(
        (candidate) => candidate.id === operation.destinationId,
      );
      const currentResource = database.protectedResources.find(
        (candidate) => candidate.id === operation.resource.id,
      );
      if (
        !currentDestination ||
        currentDestination.status !== "enabled" ||
        currentDestination.revision !== operation.destinationRevision ||
        !currentResource ||
        currentResource.type !== "content_asset" ||
        currentResource.revision !== operation.resourceRevision ||
        currentResource.assetId !== operation.resource.assetId ||
        currentResource.contentVersion !== operation.resource.contentVersion ||
        currentResource.ownerUserId !== operation.resource.ownerUserId ||
        currentResource.classification !== operation.resource.classification ||
        currentResource.organizationId !== operation.resource.organizationId ||
        currentResource.businessCenterId !== operation.resource.businessCenterId ||
        currentResource.accountId !== operation.resource.accountId
      ) {
        throw new LocalDestinationAdapterError("Destination or protected resource revision changed");
      }
      const currentOperation = { ...operation, resource: currentResource };
      this.assertDestinationBinding(currentDestination, currentOperation);
      if (!isRegisteredDestination(currentDestination)) {
        throw new LocalDestinationAdapterError("Registered destination metadata is invalid");
      }
      await operation.execution?.finalRecheck?.(database);
      const httpsPath = materializeDestinationPath(currentDestination, {
        accountId: currentResource.accountId,
        organizationId: currentResource.organizationId,
        assetId: currentResource.assetId,
      });

      // JsonStore serializes this entire callback. The binding recheck above
      // therefore completes before the broker releases the credential, and no
      // concurrent catalogue/resource mutation can slip between those steps.
      return this.broker.withCredential(currentDestination, async (credential) => {
        if (credential.length === 0) {
          throw new LocalDestinationAdapterError("Destination credential unavailable");
        }
        const receipt: DestinationSideEffectReceipt = {
          id: randomUUID(),
          destinationId: operation.destinationId,
          action: operation.action,
          resourceId: currentResource.id,
          purpose: operation.purpose,
          httpMethod: currentDestination.httpMethod,
          httpsHost: currentDestination.httpsHost,
          httpsPath,
          environment: currentDestination.environment,
          destinationRevision: currentDestination.revision,
          resourceRevision: currentResource.revision,
          credentialRef: currentDestination.credentialRef,
          createdAt: new Date().toISOString(),
        };
        database.destinationReceipts.push(structuredClone(receipt));
        if (operation.execution) {
          const summary = operation.action === "content.publish"
            ? "Published content for " + currentResource.assetId
            : operation.action === "content.export"
              ? "Exported content for " + currentResource.assetId
              : "Disclosed approved content for " + currentResource.assetId;
          const resultSummary: ActionExecutionRecord["resultSummary"] = {
            summary,
            destinationReceiptId: receipt.id,
          };
          database.actionExecutions.push({
            runId: operation.execution.runId,
            requestId: operation.execution.requestId,
            payloadDigest: operation.execution.payloadDigest,
            destination: operation.execution.destination,
            policyRevision: operation.execution.policyRevision,
            resourceRevision: currentResource.revision,
            destinationRevision: currentDestination.revision,
            requesterHumanId: operation.execution.requesterHumanId ?? null,
            organizationId: operation.execution.organizationId ?? null,
            accountId: operation.execution.accountId ?? null,
            risk: operation.execution.risk ?? null,
            riskVersion: operation.execution.riskVersion ?? null,
            riskFactsDigest: operation.execution.riskFactsDigest ?? null,
            requiredApprovalCount: operation.execution.requiredApprovalCount ?? null,
            requiredApprovalRoles: operation.execution.requiredApprovalRoles ?? null,
            approvalDecisions: operation.execution.approvalDecisions ?? null,
            action: operation.action,
            resourceId: currentResource.id,
            status: "succeeded",
            resultSummary,
            destinationReceiptId: receipt.id,
            completedAt: receipt.createdAt,
          });
        }
        return structuredClone(receipt);
      });
    });
  }

  private assertDestinationBinding(
    destination: RegisteredDestination,
    operation: ContentDestinationExecution,
  ): void {
    if (destination.status !== "enabled") {
      throw new LocalDestinationAdapterError("Registered destination is revoked");
    }
    if (destination.revision !== operation.destinationRevision) {
      throw new LocalDestinationAdapterError("Destination revision changed");
    }
    if (!destination.allowedActions.includes(operation.action)) {
      throw new LocalDestinationAdapterError("Destination action is not allowed");
    }
    if (!destination.purposes.includes(operation.purpose)) {
      throw new LocalDestinationAdapterError("Destination purpose is not allowed");
    }
    const expectedClassification = operation.action === "content.disclose" ? "sensitive" : "restricted";
    if (destination.classification !== expectedClassification) {
      throw new LocalDestinationAdapterError("Destination classification is not allowed");
    }
    if (destination.environment !== "local") {
      throw new LocalDestinationAdapterError("Destination environment is not allowed");
    }
    if (
      destination.organizationId !== operation.resource.organizationId ||
      destination.businessCenterId !== operation.resource.businessCenterId ||
      destination.accountId !== operation.resource.accountId
    ) {
      throw new LocalDestinationAdapterError("Destination tenant does not match the protected asset");
    }
  }
}

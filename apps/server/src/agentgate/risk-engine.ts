import { canonicalPayloadDigest } from "./canonical-json.js";
import { isRegisteredDestinationId } from "./destination-catalogue.js";
import type {
  AgentGateAction,
  AssetType,
  DestinationAudience,
  DestinationEnvironment,
  DestinationReach,
  RegisteredDestinationId,
  Region,
  ResourceClassification,
  RiskTier,
} from "./types.js";
import { AGENTGATE_RISK_VERSION } from "./types.js";

export interface RiskFacts {
  action: AgentGateAction;
  resourceClassification: ResourceClassification;
  destinationId: RegisteredDestinationId | null;
  destinationEnvironment: DestinationEnvironment;
  destinationAudience: DestinationAudience;
  destinationReach: DestinationReach;
  assetType: AssetType;
  sourceRegion: Region;
  destinationRegion: Region | null;
  resourceRevision: number;
  destinationRevision: number | null;
}

export type RiskAssessment =
  | {
      outcome: "allow";
      riskTier: RiskTier;
      riskVersion: typeof AGENTGATE_RISK_VERSION;
      facts: RiskFacts;
      factsDigest: string;
    }
  | {
      outcome: "deny";
      riskTier: "critical";
      riskVersion: typeof AGENTGATE_RISK_VERSION;
      facts: null;
      factsDigest: null;
      reasonCode: "risk_facts_malformed";
    };

export interface RiskEngine {
  assess(facts: unknown): RiskAssessment;
}

const ACTIONS = new Set<AgentGateAction>([
  "resource.read",
  "file.read",
  "deploy.staging",
  "deploy.production",
  "content.moderate",
  "content.disclose",
  "content.publish",
  "content.export",
]);
const CLASSIFICATIONS = new Set<ResourceClassification>(["internal", "sensitive", "restricted"]);
const ENVIRONMENTS = new Set<DestinationEnvironment>(["local", "staging", "production"]);
const AUDIENCES = new Set<DestinationAudience>(["owner", "team", "external"]);
const REACHES = new Set<DestinationReach>(["narrow", "broad"]);
const ASSET_TYPES = new Set<AssetType>(["project_profile", "deployment_target", "team_file", "short_video"]);
const REGIONS = new Set<Region>(["SG", "GLOBAL"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRiskFacts(value: unknown): value is RiskFacts {
  if (!isRecord(value)) return false;
  const keys = [
    "action", "resourceClassification", "destinationId", "destinationEnvironment",
    "destinationAudience", "destinationReach", "assetType", "sourceRegion",
    "destinationRegion", "resourceRevision", "destinationRevision",
  ].sort();
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)) return false;
  return (
    typeof value.action === "string" && ACTIONS.has(value.action as AgentGateAction) &&
    typeof value.resourceClassification === "string" && CLASSIFICATIONS.has(value.resourceClassification as ResourceClassification) &&
    (value.destinationId === null || isRegisteredDestinationId(value.destinationId)) &&
    typeof value.destinationEnvironment === "string" && ENVIRONMENTS.has(value.destinationEnvironment as DestinationEnvironment) &&
    typeof value.destinationAudience === "string" && AUDIENCES.has(value.destinationAudience as DestinationAudience) &&
    typeof value.destinationReach === "string" && REACHES.has(value.destinationReach as DestinationReach) &&
    typeof value.assetType === "string" && ASSET_TYPES.has(value.assetType as AssetType) &&
    typeof value.sourceRegion === "string" && REGIONS.has(value.sourceRegion as Region) &&
    (value.destinationRegion === null || (typeof value.destinationRegion === "string" && REGIONS.has(value.destinationRegion as Region))) &&
    isIntegerRevision(value.resourceRevision) &&
    (value.destinationRevision === null || isIntegerRevision(value.destinationRevision))
  );
}

function tierFor(facts: RiskFacts): RiskTier {
  if (facts.action === "resource.read" || facts.action === "content.moderate") return "low";
  if (facts.action === "file.read") return facts.resourceClassification === "restricted" ? "high" : "low";
  if (facts.action === "deploy.staging") return "medium";
  if (facts.action === "deploy.production") return "high";

  const externalBroad = facts.destinationAudience === "external" && facts.destinationReach === "broad";
  const crossRegion = facts.destinationRegion !== null && facts.destinationRegion !== facts.sourceRegion;
  if (facts.action === "content.disclose") {
    return externalBroad || crossRegion ? "medium" : "low";
  }
  if (facts.resourceClassification === "sensitive" && (externalBroad || crossRegion || facts.action === "content.export")) {
    return "critical";
  }
  return "high";
}

export class DeterministicRiskEngine implements RiskEngine {
  assess(input: unknown): RiskAssessment {
    if (!isRiskFacts(input)) {
      return {
        outcome: "deny",
        riskTier: "critical",
        riskVersion: AGENTGATE_RISK_VERSION,
        facts: null,
        factsDigest: null,
        reasonCode: "risk_facts_malformed",
      };
    }
    const facts = structuredClone(input);
    return {
      outcome: "allow",
      riskTier: tierFor(facts),
      riskVersion: AGENTGATE_RISK_VERSION,
      facts,
      factsDigest: canonicalPayloadDigest(facts),
    };
  }
}

export function riskFactsDigest(facts: RiskFacts): string {
  return canonicalPayloadDigest(facts);
}

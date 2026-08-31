import { describe, expect, it } from "vitest";
import { DeterministicRiskEngine } from "./risk-engine.js";
import type { RiskFacts } from "./risk-engine.js";

const baseFacts: RiskFacts = {
  action: "content.publish",
  resourceClassification: "sensitive",
  destinationId: "tiktok-account:brand-sg",
  destinationEnvironment: "local",
  destinationAudience: "external",
  destinationReach: "broad",
  assetType: "short_video",
  sourceRegion: "SG",
  destinationRegion: "SG",
  resourceRevision: 1,
  destinationRevision: 1,
};

describe("risk-v1", () => {
  it("assigns deterministic low, medium, high, and critical tiers", () => {
    const engine = new DeterministicRiskEngine();
    expect(engine.assess({
      ...baseFacts,
      action: "resource.read",
      destinationId: null,
      destinationAudience: "owner",
      destinationReach: "narrow",
      destinationRegion: null,
      destinationRevision: null,
      assetType: "project_profile",
    })).toMatchObject({ outcome: "allow", riskTier: "low", riskVersion: "risk-v1" });
    expect(engine.assess({
      ...baseFacts,
      action: "deploy.staging",
      resourceClassification: "internal",
      destinationId: null,
      destinationAudience: "owner",
      destinationReach: "narrow",
      destinationRegion: null,
      destinationRevision: null,
      assetType: "deployment_target",
    })).toMatchObject({ outcome: "allow", riskTier: "medium" });
    expect(engine.assess({
      ...baseFacts,
      resourceClassification: "restricted",
    })).toMatchObject({ outcome: "allow", riskTier: "high" });
    expect(engine.assess(baseFacts)).toMatchObject({ outcome: "allow", riskTier: "critical" });
  });

  it("fails closed for malformed or extra facts and is stable for the same facts", () => {
    const engine = new DeterministicRiskEngine();
    const first = engine.assess(baseFacts);
    const second = engine.assess(structuredClone(baseFacts));
    expect(second).toEqual(first);
    expect(engine.assess({ ...baseFacts, payload: "untrusted" })).toMatchObject({
      outcome: "deny",
      reasonCode: "risk_facts_malformed",
    });
    expect(engine.assess({ ...baseFacts, destinationId: "unknown:destination" })).toMatchObject({
      outcome: "deny",
      reasonCode: "risk_facts_malformed",
    });
  });
});

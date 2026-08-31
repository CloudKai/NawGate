import { describe, expect, it } from "vitest";
import {
  mergeSecurityLabResult,
  shouldAutoDismissSecurityLabResult,
} from "../../../web/src/components/nawgate/SecurityLab";
import type {
  SecurityLabResult,
  SecurityLabScenario,
} from "../../../web/src/types";

function result(
  scenario: SecurityLabScenario,
  requestId: string,
  operationState: SecurityLabResult["operationState"] = "terminal",
): SecurityLabResult {
  return {
    scenario,
    scenarioId: operationState === "pending_approval" ? "scenario-1" : null,
    humanId: "user-a",
    agentId: "agent-a",
    runId: "run-" + requestId,
    requestId,
    action: "resource.read",
    resourceId: "project-a",
    teamId: null,
    status: operationState === "pending_approval" ? "approval_required" : "success",
    decision: operationState === "pending_approval" ? "require_approval" : "allow",
    initialDecision: null,
    operationState,
    revocationPerformed: false,
    reasonCode: "test_result",
    approvalId: operationState === "pending_approval" ? "approval-1" : null,
    policyVersion: "bouncer-v5",
    enforcementPoint: "RuntimeGateway",
    protectedActionExecuted: operationState !== "pending_approval",
    summary: "Safe test result.",
  };
}

describe("Security Lab result lifecycle", () => {
  it("replaces an earlier card for the same scenario instead of stacking duplicates", () => {
    const pending = result("alpha-restricted-jit", "request-pending", "pending_approval");
    const completed = result("alpha-restricted-jit", "request-completed");

    expect(mergeSecurityLabResult([pending], completed)).toEqual([completed]);
  });

  it("keeps only the four most recent distinct scenarios", () => {
    const current = [
      result("own-project", "request-1"),
      result("cross-user-project", "request-2"),
      result("alpha-internal", "request-3"),
      result("beta-cross-team", "request-4"),
    ];
    const latest = result("forged-team-admin", "request-5");

    expect(mergeSecurityLabResult(current, latest).map((item) => item.requestId)).toEqual([
      "request-5",
      "request-1",
      "request-2",
      "request-3",
    ]);
  });

  it("keeps pending approval cards visible and auto-dismisses terminal cards", () => {
    expect(
      shouldAutoDismissSecurityLabResult(
        result("alpha-restricted-jit", "request-pending", "pending_approval"),
      ),
    ).toBe(false);
    expect(shouldAutoDismissSecurityLabResult(result("own-project", "request-terminal"))).toBe(
      true,
    );
  });
});

import { describe, expect, it } from "vitest";
import { DeterministicPolicyEngine } from "./policy-engine.js";
import type { PolicyInput } from "./types.js";

const userA = { id: "user-a", name: "User A" } as const;
const projectA = {
  id: "project-a",
  type: "project_profile" as const,
  ownerUserId: "user-a" as const,
  classification: "sensitive" as const,
};

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    humanId: userA.id,
    agentId: "agent-a",
    runId: "run-a",
    requestId: "request-a",
    action: "resource.read",
    resource: projectA,
    environment: "local",
    ...overrides,
  };
}

describe("DeterministicPolicyEngine", () => {
  const policy = new DeterministicPolicyEngine();

  it("allows an owner to read their project profile", async () => {
    await expect(policy.evaluate(input())).resolves.toEqual({
      outcome: "allow",
      risk: "low",
      reasonCode: "owned_resource_read",
    });
  });

  it("hard-denies a cross-user resource before approval", async () => {
    await expect(
      policy.evaluate(input({
        humanId: "user-a",
        resource: { ...projectA, ownerUserId: "user-b" },
      })),
    ).resolves.toEqual({
      outcome: "deny",
      risk: "high",
      reasonCode: "resource_owner_mismatch",
    });
  });

  it("allows owned staging deploys and requires approval for production", async () => {
    const staging = await policy.evaluate(
      input({
        action: "deploy.staging",
        resource: {
          id: "staging",
          type: "deployment_target",
          ownerUserId: "user-a",
          classification: "internal",
        },
        environment: "staging",
      }),
    );
    expect(staging).toEqual({
      outcome: "allow",
      risk: "medium",
      reasonCode: "owned_staging_deploy",
    });

    await expect(
      policy.evaluate(
        input({
          action: "deploy.production",
          resource: {
            id: "production",
            type: "deployment_target",
            ownerUserId: "user-a",
            classification: "sensitive",
          },
          environment: "production",
        }),
      ),
    ).resolves.toEqual({
      outcome: "require_approval",
      risk: "high",
      reasonCode: "production_deploy_requires_owner_approval",
    });
  });

  it("denies unknown actions and malformed contexts", async () => {
    await expect(
      policy.evaluate(input({ action: "resource.delete" as PolicyInput["action"] })),
    ).resolves.toEqual({
      outcome: "deny",
      risk: "low",
      reasonCode: "unknown_action",
    });
    await expect(policy.evaluate(undefined as unknown as PolicyInput)).resolves.toEqual({
      outcome: "deny",
      risk: "high",
      reasonCode: "invalid_context",
    });
  });
});

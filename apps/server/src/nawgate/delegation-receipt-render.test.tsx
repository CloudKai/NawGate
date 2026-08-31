import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DelegationReceipt } from "../../../web/src/components/nawgate/DelegationReceipt";
import type { Agent, ApprovalRecord, AuditEvent } from "../../../web/src/types";

describe("DelegationReceipt redaction", () => {
  it("renders safe approval metadata without credential-bearing fields", () => {
    const canary = "DESTINATION_SECRET_CANARY_RENDERED_RECEIPT";
    const approval = {
      id: "approval-1",
      humanId: "user-a",
      agentId: "agent-a",
      runId: "run-a",
      requestId: "request-a",
      action: "content.publish",
      resourceId: "asset-user-a-video-1",
      risk: "critical",
      reasonCode: "content_publish_requires_owner_approval",
      status: "consumed",
      createdAt: "2026-08-30T00:00:00.000Z",
      decidedAt: "2026-08-30T00:00:01.000Z",
      expiresAt: "2026-08-30T00:05:00.000Z",
      destination: "tiktok-account:brand-sg",
      destinationRevision: 1,
      requesterHumanId: "user-a",
      riskVersion: "risk-v1",
      riskFactsDigest: "0".repeat(64),
      requiredApprovalCount: 2,
      requiredApprovalRoles: ["owner", "independent_reviewer"],
      approvalDecisions: [{
        humanId: "user-a",
        authorityId: "authority-owner",
        authorityRevision: 1,
        role: "owner",
        decision: "approve",
        decidedAt: "2026-08-30T00:00:01.000Z",
      }],
      credential: canary,
    } as ApprovalRecord & { credential: string };
    const audit = {
      id: "audit-1",
      eventType: "policy.approval_required",
      createdAt: "2026-08-30T00:00:00.000Z",
      humanId: "user-a",
      agentId: "agent-a",
      runId: "run-a",
      requestId: "request-a",
      action: "content.publish",
      resourceId: "asset-user-a-video-1",
      decision: "require_approval",
      risk: "critical",
      reasonCode: "content_publish_requires_owner_approval",
      approvalId: "approval-1",
      capabilityId: null,
      status: "pending",
      durationMs: 1,
      policyVersion: "bouncer-v4",
      explanation: "Owner approval is required.",
      enforcementPoint: "RuntimeGateway",
      protectedActionExecuted: false,
      riskVersion: "risk-v1",
      riskFactsDigest: "0".repeat(64),
      requiredApprovalCount: 2,
      requiredApprovalRoles: ["owner", "independent_reviewer"],
      approvalDecisions: [{
        humanId: "user-a",
        authorityId: "authority-owner",
        authorityRevision: 1,
        role: "owner",
        decision: "approve",
        decidedAt: "2026-08-30T00:00:01.000Z",
      }],
      credential: canary,
    } as AuditEvent & { credential: string };
    const agent = {
      id: "agent-a",
      name: "Agent A",
    } as Agent;

    const markup = renderToStaticMarkup(
      React.createElement(DelegationReceipt, {
        agent,
        approvals: [approval],
        audit: [audit],
      }),
    );

    expect(markup).toContain("tiktok-account:brand-sg");
    expect(markup).toContain("v1");
    expect(markup).toContain("1 / 2");
    expect(markup).toContain("independent_reviewer");
    expect(markup).not.toContain(canary);
  });
});

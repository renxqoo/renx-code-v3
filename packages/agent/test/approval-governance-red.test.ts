import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  InMemoryApprovalDecisionStore,
  RuleBasedApprovalEngine,
  createToolCapabilityProfile,
  type AgentTool,
} from "../src";
import { baseCtx } from "./helpers";

describe("approval governance", () => {
  it("evaluates policy chains using tool capability risk and approver scope", async () => {
    const tool: AgentTool = {
      name: "deploy",
      description: "Deploy production services",
      schema: z.object({ environment: z.string() }),
      profile: createToolCapabilityProfile({
        riskLevel: "critical",
        capabilityTags: ["filesystem_write", "network", "deploy"],
        sandboxExpectation: "workspace-write",
        auditCategory: "deployment",
      }),
      invoke: async () => ({ content: "ok" }),
    };

    const store = new InMemoryApprovalDecisionStore();
    const engine = new RuleBasedApprovalEngine(store, [
      {
        id: "critical-deploy",
        match: {
          minimumRiskLevel: "high",
          capabilityTags: ["deploy"],
        },
        requireApproval: true,
        approverScope: "org",
        reason: "Critical deployment requires org-level approval.",
      },
    ]);

    const evaluation = await engine.evaluate(baseCtx(), tool, { environment: "prod" });
    expect(evaluation.required).toBe(true);
    expect(evaluation.metadata?.["riskLevel"]).toBe("critical");
    expect(evaluation.metadata?.["approverScope"]).toBe("org");

    await engine.request(baseCtx(), {
      id: "apt_1",
      runId: "run_1",
      toolName: tool.name,
      input: { environment: "prod" },
      requestedAt: "2026-04-05T00:00:00.000Z",
      reason: String(evaluation.reason),
      ...(evaluation.metadata ? { metadata: evaluation.metadata } : {}),
    });
    await store.decide("apt_1", { ticketId: "apt_1", status: "approved", reviewerId: "org-admin" });

    const decision = await engine.getDecision(baseCtx(), "apt_1");
    expect(decision?.status).toBe("approved");
  });
});

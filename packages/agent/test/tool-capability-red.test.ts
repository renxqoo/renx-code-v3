import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createToolCapabilityProfile, getToolRiskLevel, type AgentTool } from "../src";

describe("tool capability model", () => {
  it("normalizes capability metadata for policy and audit decisions", () => {
    const tool: AgentTool = {
      name: "bash",
      description: "Execute shell commands",
      schema: z.object({ command: z.string() }),
      profile: createToolCapabilityProfile({
        riskLevel: "high",
        capabilityTags: ["filesystem_write", "process_exec"],
        sandboxExpectation: "workspace-write",
        auditCategory: "execution",
      }),
      invoke: async () => ({ content: "ok" }),
    };

    expect(getToolRiskLevel(tool)).toBe("high");
    expect(tool.profile?.auditCategory).toBe("execution");
  });
});

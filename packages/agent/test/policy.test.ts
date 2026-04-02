import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AllowAllPolicy } from "../src/policy";
import type { PolicyEngine } from "../src/types";
import type { AgentTool, ToolResult } from "../src/tool/types";
import { baseCtx } from "./helpers";

const mockTool: AgentTool = {
  name: "test",
  description: "A test tool",
  schema: z.object({}).passthrough(),
  invoke: async (): Promise<ToolResult> => ({ content: "ok" }),
};

const otherTool: AgentTool = {
  name: "other",
  description: "Another test tool",
  schema: z.object({}).passthrough(),
  invoke: async (): Promise<ToolResult> => ({ content: "other" }),
};

describe("AllowAllPolicy", () => {
  it("returns all tools unchanged", () => {
    const policy = new AllowAllPolicy();
    const ctx = baseCtx();
    const tools = [mockTool];
    expect(policy.filterTools(ctx, tools)).toBe(tools);
  });

  it("always allows tool use", () => {
    const policy = new AllowAllPolicy();
    expect(policy.canUseTool(baseCtx(), mockTool, {})).toBe(true);
  });
});

describe("Custom PolicyEngine implementations", () => {
  it("custom policy that filters tools", async () => {
    const policy: PolicyEngine = {
      filterTools: (_ctx, tools) => tools.filter((t) => t.name === "test"),
      canUseTool: () => true,
    };

    const filtered = await policy.filterTools(baseCtx(), [mockTool, otherTool]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.name).toBe("test");
  });

  it("custom policy that denies tool use (canUseTool returns false)", async () => {
    const policy: PolicyEngine = {
      filterTools: (_ctx, tools) => tools,
      canUseTool: () => false,
    };

    const canUse = await policy.canUseTool(baseCtx(), mockTool, {});
    expect(canUse).toBe(false);
  });

  it("custom policy with needApproval returning true", async () => {
    const policy: PolicyEngine = {
      filterTools: (_ctx, tools) => tools,
      canUseTool: () => true,
      needApproval: () => true,
    };

    const needsApproval = await policy.needApproval!(baseCtx(), mockTool, {});
    expect(needsApproval).toBe(true);
  });

  it("custom policy with redactOutput", async () => {
    const policy: PolicyEngine = {
      filterTools: (_ctx, tools) => tools,
      canUseTool: () => true,
      redactOutput: (_ctx, output) => `[REDACTED] ${output}`,
    };

    const redacted = await policy.redactOutput!(baseCtx(), "secret data");
    expect(redacted).toBe("[REDACTED] secret data");
  });
});

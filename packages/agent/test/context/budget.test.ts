import { describe, expect, it } from "vitest";

import { estimateInputTokens } from "../../src/context/budget";
import { initialContextRuntimeState } from "../../src/context";

describe("estimateInputTokens", () => {
  it("prefers current estimate after major compaction even when last usage was much larger", () => {
    const state = initialContextRuntimeState();
    state.lastKnownUsage = {
      inputTokens: 80_000,
    };
    state.lastUsageAnchorMessageCount = 2;

    const estimated = estimateInputTokens({
      systemPrompt: "sys",
      messages: [
        {
          id: "boundary",
          role: "system",
          content: "[Compact Boundary:b1]",
          createdAt: new Date().toISOString(),
        },
        {
          id: "summary",
          role: "system",
          content: "[Compact Summary:s1]\nsmall summary",
          createdAt: new Date().toISOString(),
        },
        {
          id: "memory",
          role: "system",
          content: '[Agent Memory]\n{"activePlan":"tiny"}',
          createdAt: new Date().toISOString(),
        },
      ],
      tools: [],
      state,
    });

    expect(estimated).toBeLessThan(1_000);
  });
});

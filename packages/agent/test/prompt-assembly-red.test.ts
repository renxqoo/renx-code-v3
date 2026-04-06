import { describe, expect, it } from "vitest";

import { PromptAssembler } from "../src";

describe("prompt assembly", () => {
  it("assembles prioritized prompt layers by phase under budget and emits a post-compact contract", () => {
    const assembler = new PromptAssembler();
    const result = assembler.assemble({
      baseSystemPrompt: "You are a coding agent.",
      budgetTokens: 40,
      layers: [
        {
          id: "rules",
          phase: "rules",
          priority: 100,
          content: "Always write red tests first and run typecheck.",
        },
        {
          id: "memory",
          phase: "memory",
          priority: 80,
          content: "Recent file: src/runtime.ts and active plan: fix approval edge cases.",
        },
        {
          id: "overflow",
          phase: "context",
          priority: 1,
          content: "x".repeat(500),
        },
      ],
      postCompact: {
        summary: "Compacted prior history.",
        preservedRequirements: ["retain active plan", "retain recent file excerpts"],
      },
    });

    expect(result.systemPrompt).toContain("You are a coding agent.");
    expect(result.systemPrompt).toContain("Always write red tests first");
    expect(result.selectedLayerIds).toEqual(["rules", "memory"]);
    expect(result.droppedLayerIds).toContain("overflow");
    expect(result.contract.postCompact?.preservedRequirements).toContain("retain active plan");
  });
});

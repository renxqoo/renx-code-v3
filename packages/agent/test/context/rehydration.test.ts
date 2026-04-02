import { describe, expect, it } from "vitest";

import { buildRehydrationHints } from "../../src/context/rehydration";

describe("buildRehydrationHints", () => {
  it("respects rehydration budgets for files and skills", () => {
    const hints = buildRehydrationHints({
      memory: {
        recentFiles: Array.from({ length: 10 }, (_, i) => `a/very/long/path/file-${i}.ts`),
        skills: Array.from({ length: 20 }, (_, i) => `skill-${i}-with-long-detail`),
        activePlan: "plan-step-1",
      },
      rehydrationTokenBudget: 40,
      recentFileBudgetTokens: 10,
      skillsRehydrateBudgetTokens: 10,
    });

    expect(hints.length).toBeGreaterThanOrEqual(1);
    const content = hints[0]?.content ?? "";
    expect(content).toContain("[Post Compact Rehydration]");
    expect(content).toContain("budget:40");
  });
});

import { describe, expect, it } from "vitest";

import type { AgentMessage } from "@renx/model";

import { initialContextRuntimeState } from "../../src/context";
import {
  applyToolResultBudget,
  hydrateToolResultCacheRefs,
} from "../../src/context/tool-result-budget";

describe("tool result budget", () => {
  it("hydrates cached tool result refs back into view", () => {
    const state = initialContextRuntimeState();
    const messages: AgentMessage[] = [
      {
        id: "tool_1",
        role: "tool",
        createdAt: new Date().toISOString(),
        content: "x".repeat(10_000),
      },
    ];

    const budgeted = applyToolResultBudget(messages, state, {
      maxInputTokens: 96_000,
      maxOutputTokens: 8_000,
      maxPromptTooLongRetries: 3,
      maxReactiveCompactAttempts: 3,
      maxCompactRequestRetries: 2,
      compactRequestMaxInputChars: 20_000,
      maxConsecutiveCompactFailures: 3,
      toolResultSoftCharLimit: 1_000,
      historySnipKeepRounds: 50,
      historySnipMaxDropRounds: 10,
      microcompactMaxToolChars: 1_500,
      collapseRestoreMaxMessages: 8,
      collapseRestoreTokenHeadroomRatio: 0.6,
      rehydrationTokenBudget: 50_000,
      recentFileBudgetTokens: 5_000,
      skillsRehydrateBudgetTokens: 25_000,
      thresholds: {
        warningBufferTokens: 20_000,
        autoCompactBufferTokens: 13_000,
        errorBufferTokens: 20_000,
        blockingHeadroomTokens: 3_000,
      },
    });

    const hydrated = hydrateToolResultCacheRefs(budgeted.messages, budgeted.nextState, 120);
    expect(hydrated[0]?.content).toContain("...[hydrated from cache]");
  });
});

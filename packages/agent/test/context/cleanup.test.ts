import { describe, expect, it } from "vitest";

import { runPostCompactCleanup } from "../../src/context/cleanup";
import { initialContextRuntimeState } from "../../src/context";

describe("runPostCompactCleanup", () => {
  it("resets collapse state and trims tool cache", () => {
    const state = initialContextRuntimeState();
    state.consecutiveCompactFailures = 2;
    state.contextCollapseState = {
      collapsedMessageIds: ["a", "b"],
      lastCollapsedAt: new Date().toISOString(),
      segments: {
        s1: {
          createdAt: new Date().toISOString(),
          messageIds: ["a", "b"],
          messages: [
            {
              id: "a",
              role: "user",
              createdAt: new Date().toISOString(),
              content: "a",
            },
            {
              id: "b",
              role: "assistant",
              createdAt: new Date().toISOString(),
              content: "b",
            },
          ],
        },
      },
    };
    for (let i = 0; i < 80; i += 1) {
      state.toolResultCache[`ref_${i}`] = `value_${i}`;
    }

    const cleaned = runPostCompactCleanup(state);
    expect(cleaned.consecutiveCompactFailures).toBe(0);
    expect(cleaned.contextCollapseState).toBeUndefined();
    expect(Object.keys(cleaned.toolResultCache).length).toBeLessThanOrEqual(50);
    expect(cleaned.toolResultStorageState?.evictedRefs.length).toBeGreaterThan(0);
  });

  it("keeps collapse state for subagent cleanup sources", () => {
    const state = initialContextRuntimeState();
    state.contextCollapseState = {
      collapsedMessageIds: ["a"],
      lastCollapsedAt: new Date().toISOString(),
      segments: {
        s1: {
          createdAt: new Date().toISOString(),
          messageIds: ["a"],
          messages: [
            {
              id: "a",
              role: "user",
              createdAt: new Date().toISOString(),
              content: "a",
            },
          ],
        },
      },
    };

    const cleaned = runPostCompactCleanup(state, "agent:custom");

    expect(cleaned.contextCollapseState).toBeDefined();
    expect(cleaned.contextCollapseState?.collapsedMessageIds).toEqual(["a"]);
  });
});

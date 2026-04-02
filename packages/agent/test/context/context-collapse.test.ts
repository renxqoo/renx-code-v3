import { describe, expect, it } from "vitest";

import type { AgentMessage } from "@renx/model";

import { initialContextRuntimeState } from "../../src/context";
import { applyContextCollapse, restoreCollapsedContext } from "../../src/context/context-collapse";

const buildMessages = (count: number): AgentMessage[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `m_${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message-${i}`,
    createdAt: new Date(1_700_000_000_000 + i).toISOString(),
  }));

describe("context collapse reversible flow", () => {
  it("stores collapsed middle segment and can restore part of it", () => {
    const state = initialContextRuntimeState();
    const collapsed = applyContextCollapse(buildMessages(16), state);

    expect(collapsed.nextState.contextCollapseState).toBeDefined();
    const segments = collapsed.nextState.contextCollapseState?.segments ?? {};
    const segmentId = Object.keys(segments)[0];
    expect(segmentId).toBeDefined();
    expect(segments[segmentId!]?.messages.length).toBeGreaterThan(0);

    const restored = restoreCollapsedContext(collapsed.messages, collapsed.nextState, 4);
    expect(restored.restored).toBe(true);
    expect(restored.nextState.contextCollapseState?.lastRestoredAt).toBeDefined();
    expect(restored.messages.some((m) => m.id.startsWith("collapse_"))).toBe(false);
  });
});

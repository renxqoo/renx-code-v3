import { describe, expect, it } from "vitest";

import type { AgentMessage } from "@renx/model";

import { initialContextRuntimeState } from "../../src/context";
import { applySessionMemoryCompact } from "../../src/context/session-memory-compact";
import type { RunMessage } from "../../src/message/types";

const buildMessages = (): AgentMessage[] =>
  Array.from({ length: 12 }, (_, i) => ({
    id: `m_${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message-${i}`,
    createdAt: new Date(1_700_000_000_000 + i).toISOString(),
  }));

describe("session memory compact", () => {
  it("prefers hot summary and includes cold summary section", () => {
    const state = initialContextRuntimeState();
    state.sessionMemoryState = {
      hotSummaryText: "hot summary with enough content for compact context reuse",
      coldSummaryText: "cold summary baseline",
    };

    const canonical: RunMessage[] = buildMessages().map((m, i) => ({
      ...m,
      messageId: `msg_${i}`,
      source: "input",
      roundIndex: Math.floor(i / 2),
    }));
    const compacted = applySessionMemoryCompact(buildMessages(), canonical, {}, state);
    const first = compacted.messages[0];
    expect(first?.role).toBe("system");
    expect(compacted.messages[1]?.content).toContain("## Hot");
    expect(compacted.messages[1]?.content).toContain("## Cold");
    expect(compacted.boundary?.strategy).toBe("session_memory");
    expect(compacted.nextState.sessionMemoryState?.hotSummaryText).toContain("hot summary");
  });
});

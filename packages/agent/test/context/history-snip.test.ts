import { describe, expect, it } from "vitest";

import type { AgentMessage } from "@renx/model";

import { applyHistorySnip } from "../../src/context/history-snip";
import { buildRehydrationHints } from "../../src/context/rehydration";
import { createMemorySnapshot } from "../../src/memory";
import type { RunMessage } from "../../src/message/types";

const makeMessage = (
  id: string,
  roundIndex: number,
  role: RunMessage["role"],
  atomicGroupId?: string,
): RunMessage => ({
  id,
  messageId: `${id}_msg`,
  role,
  content: `${id}-content`,
  createdAt: new Date().toISOString(),
  source: "input",
  roundIndex,
  ...(atomicGroupId ? { atomicGroupId } : {}),
});

const toApi = (messages: RunMessage[]): AgentMessage[] =>
  messages.map(({ messageId: _messageId, source: _source, roundIndex: _roundIndex, ...m }) => m);

describe("applyHistorySnip", () => {
  it("keeps atomic grouped messages together even across round cut", () => {
    const canonical: RunMessage[] = [
      makeMessage("r0_user", 0, "user"),
      makeMessage("r0_assistant_tool_call", 0, "assistant", "g1"),
      makeMessage("r2_tool_result", 2, "tool", "g1"),
      makeMessage("r2_user", 2, "user"),
      makeMessage("r3_user", 3, "user"),
    ];

    const result = applyHistorySnip(toApi(canonical), canonical, 3);
    const keptIds = result.canonicalMessages.map((m) => m.id);

    expect(keptIds).toContain("r0_assistant_tool_call");
    expect(keptIds).toContain("r2_tool_result");
  });

  it("keeps assistant/tool_result pair even without atomicGroupId", () => {
    const canonical: RunMessage[] = [
      {
        ...makeMessage("r0_assistant", 0, "assistant"),
        toolCalls: [{ id: "tc_1", name: "echo", input: { text: "hi" } }],
      },
      {
        ...makeMessage("r3_user", 3, "user"),
      },
      {
        ...makeMessage("r4_tool", 4, "tool"),
        toolCallId: "tc_1",
        name: "echo",
      },
      {
        ...makeMessage("r5_user", 5, "user"),
      },
    ];

    const result = applyHistorySnip(toApi(canonical), canonical, 3);
    const keptIds = result.canonicalMessages.map((m) => m.id);

    expect(keptIds).toContain("r0_assistant");
    expect(keptIds).toContain("r4_tool");
  });

  it("keeps thinking chunk group together across snip boundary", () => {
    const canonical: RunMessage[] = [
      {
        ...makeMessage("r0_assistant_thinking", 0, "assistant"),
        thinkingChunkGroupId: "th1",
      },
      {
        ...makeMessage("r4_assistant_text", 4, "assistant"),
        thinkingChunkGroupId: "th1",
      },
      {
        ...makeMessage("r5_user", 5, "user"),
      },
      {
        ...makeMessage("r6_user", 6, "user"),
      },
    ];

    const result = applyHistorySnip(toApi(canonical), canonical, 3);
    const keptIds = result.canonicalMessages.map((m) => m.id);
    expect(keptIds).toContain("r0_assistant_thinking");
    expect(keptIds).toContain("r4_assistant_text");
  });

  it("preserves transient api-only context messages while snipping canonical history", () => {
    const canonical: RunMessage[] = Array.from({ length: 6 }, (_, idx) =>
      makeMessage(`r${idx}`, idx, idx % 2 === 0 ? "user" : "assistant"),
    );
    const transientMemoryMessage: AgentMessage = {
      id: "memory_only",
      role: "system",
      content: '[Agent Memory]\n{"activePlan":"keep me"}',
      createdAt: new Date().toISOString(),
    };

    const result = applyHistorySnip([transientMemoryMessage, ...toApi(canonical)], canonical, 3);

    expect(result.canonicalMessages.map((m) => m.id)).not.toContain("memory_only");
    expect(result.apiView.map((m) => m.id)).toContain("memory_only");
  });

  it("retains rehydration hint appended after recovery as the newest logical context", () => {
    const hints = buildRehydrationHints({
      memory: createMemorySnapshot({
        working: {
          activePlan: "keep",
        },
      }),
      rehydrationTokenBudget: 100,
      recentFileBudgetTokens: 20,
      skillsRehydrateBudgetTokens: 20,
      roundIndex: 999,
    });
    const canonical: RunMessage[] = [
      ...Array.from({ length: 6 }, (_, idx) =>
        makeMessage(`r${idx}`, idx, idx % 2 === 0 ? "user" : "assistant"),
      ),
      ...hints,
    ];

    const result = applyHistorySnip(toApi(canonical), canonical, 1);

    expect(result.canonicalMessages.map((m) => m.id)).toContain(hints[0]!.id);
  });

  it("retains compact boundary and summary even when they have no roundIndex", () => {
    const canonical: RunMessage[] = [
      {
        id: "boundary_1",
        messageId: "boundary_1",
        role: "system",
        content: "[Compact Boundary:b1]",
        createdAt: new Date().toISOString(),
        source: "framework",
        compactBoundary: {
          boundaryId: "b1",
          strategy: "auto_compact",
          createdAt: new Date().toISOString(),
        },
        preservedSegmentRef: {
          segmentId: "s1",
          digest: "d1",
        },
      },
      {
        id: "summary_1",
        messageId: "summary_1",
        role: "system",
        content: "[Compact Summary:s1]\nsummary",
        createdAt: new Date().toISOString(),
        source: "framework",
        preservedSegmentRef: {
          segmentId: "s1",
          digest: "d1",
        },
      },
      ...Array.from({ length: 6 }, (_, idx) =>
        makeMessage(`r${idx}`, idx + 10, idx % 2 === 0 ? "user" : "assistant"),
      ),
    ];

    const result = applyHistorySnip(toApi(canonical), canonical, 2);
    const keptIds = result.canonicalMessages.map((m) => m.id);

    expect(keptIds).toContain("boundary_1");
    expect(keptIds).toContain("summary_1");
  });
});

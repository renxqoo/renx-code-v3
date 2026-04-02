import { describe, expect, it } from "vitest";

import type { AgentMessage } from "@renx/model";

import { applyHistorySnip } from "../../src/context/history-snip";
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
});

import { describe, expect, it } from "vitest";

import type { AgentMessage } from "@renx/model";

import { applyMicrocompact } from "../../src/context/microcompact";

describe("microcompact red tests", () => {
  it("compacts stale tool output by age even when round distance is small", () => {
    const messages: AgentMessage[] = [
      {
        id: "tool_old",
        role: "tool",
        content: "x".repeat(5000),
        createdAt: "2026-01-01T00:00:00.000Z",
        roundIndex: 10,
      } as AgentMessage & { roundIndex: number },
      {
        id: "assistant_new",
        role: "assistant",
        content: "latest turn",
        createdAt: "2026-01-01T03:30:00.000Z",
        roundIndex: 11,
      } as AgentMessage & { roundIndex: number },
    ];

    const compacted = applyMicrocompact(messages, 200, 11, 60 * 60 * 1000);

    expect(compacted[0]?.content).toContain("[microcompact truncated]");
  });

  it("clears cold bash output to a stable marker instead of keeping a long truncated shell transcript", () => {
    const messages: AgentMessage[] = [
      {
        id: "tool_bash_old",
        role: "tool",
        name: "Bash",
        content: "stdout:\n" + "line\n".repeat(3000),
        createdAt: "2026-01-01T00:00:00.000Z",
        roundIndex: 3,
      } as AgentMessage & { roundIndex: number; name: string },
      {
        id: "assistant_new",
        role: "assistant",
        content: "latest turn",
        createdAt: "2026-01-01T03:30:00.000Z",
        roundIndex: 11,
      } as AgentMessage & { roundIndex: number },
    ];

    const compacted = applyMicrocompact(messages, 200, 11, 60 * 60 * 1000);

    expect(compacted[0]?.content).toBe("[Old tool result content cleared]");
  });
});

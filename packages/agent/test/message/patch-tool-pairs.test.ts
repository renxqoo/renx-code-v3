import { describe, expect, it } from "vitest";

import type { AgentMessage } from "@renx/model";

import type { RunMessage } from "../../src/message/types";

import { patchToolPairs } from "../../src/message/patch-tool-pairs";

const msg = (id: string, role: AgentMessage["role"], extra?: Partial<RunMessage>): RunMessage => ({
  id,
  messageId: id,
  role,
  content: `${role} ${id}`,
  createdAt: "2026-01-01T00:00:00Z",
  ...extra,
});

describe("patchToolPairs", () => {
  it("returns unchanged messages when all pairs are complete", () => {
    const messages: RunMessage[] = [
      msg("1", "user"),
      msg("2", "assistant", { toolCalls: [{ id: "tc_1", name: "get_weather", input: {} }] }),
      msg("3", "tool", { toolCallId: "tc_1", name: "get_weather" }),
      msg("4", "assistant"),
    ];

    const result = patchToolPairs(messages);
    expect(result.patched).toBe(false);
    expect(result.patchedToolCallIds).toHaveLength(0);
    expect(result.messages).toEqual(messages);
  });

  it("inserts synthetic tool result for missing pair", () => {
    const messages: RunMessage[] = [
      msg("1", "user"),
      msg("2", "assistant", {
        toolCalls: [{ id: "tc_1", name: "get_weather", input: { city: "Beijing" } }],
      }),
      msg("3", "assistant"), // no tool result for tc_1!
    ];

    const result = patchToolPairs(messages);
    expect(result.patched).toBe(true);
    expect(result.patchedToolCallIds).toEqual(["tc_1"]);
    expect(result.messages).toHaveLength(4); // 3 original + 1 synthetic

    const synthetic = result.messages[2]!;
    expect(synthetic.role).toBe("tool");
    expect(synthetic.toolCallId).toBe("tc_1");
    expect(synthetic.metadata).toMatchObject({
      synthetic: true,
      patchReason: "missing_tool_result",
    });
  });

  it("handles multiple missing pairs from the same assistant message", () => {
    const messages: RunMessage[] = [
      msg("1", "user"),
      msg("2", "assistant", {
        toolCalls: [
          { id: "tc_1", name: "a", input: {} },
          { id: "tc_2", name: "b", input: {} },
        ],
      }),
      msg("3", "assistant"),
    ];

    const result = patchToolPairs(messages);
    expect(result.patched).toBe(true);
    expect(result.patchedToolCallIds).toHaveLength(2);
    expect(result.messages).toHaveLength(5); // 3 original + 2 synthetic
  });

  it("handles partial pairs (some answered, some missing)", () => {
    const messages: RunMessage[] = [
      msg("1", "user"),
      msg("2", "assistant", {
        toolCalls: [
          { id: "tc_1", name: "a", input: {} },
          { id: "tc_2", name: "b", input: {} },
        ],
      }),
      msg("3", "tool", { toolCallId: "tc_1", name: "a" }),
      msg("4", "assistant"),
    ];

    const result = patchToolPairs(messages);
    expect(result.patched).toBe(true);
    expect(result.patchedToolCallIds).toEqual(["tc_2"]);
    expect(result.messages).toHaveLength(5); // 4 original + 1 synthetic for tc_2
  });

  it("returns unchanged for empty messages", () => {
    const result = patchToolPairs([]);
    expect(result.patched).toBe(false);
    expect(result.messages).toEqual([]);
  });

  it("returns unchanged when there are no tool calls", () => {
    const messages = [msg("1", "user"), msg("2", "assistant")];
    const result = patchToolPairs(messages);
    expect(result.patched).toBe(false);
  });
});

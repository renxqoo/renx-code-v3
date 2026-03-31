import { describe, expect, it } from "vitest";

import type { AgentMessage } from "@renx/model";

import type { AgentState } from "../../src/types";

import { applyMessagePatch, appendMessages, replaceMessages } from "../../src/message/reducer";

const msg = (id: string, role: AgentMessage["role"]): AgentMessage => ({
  id,
  role,
  content: `${role} ${id}`,
  createdAt: "2026-01-01T00:00:00Z",
});

const baseState: AgentState = {
  runId: "run_1",
  messages: [msg("1", "user")],
  scratchpad: {},
  memory: {},
  stepCount: 0,
  status: "running",
};

describe("applyMessagePatch", () => {
  it("replaces messages", () => {
    const newMessages = [msg("a", "assistant"), msg("b", "user")];
    const result = applyMessagePatch(baseState, { replaceMessages: newMessages });
    expect(result.messages).toEqual(newMessages);
    expect(baseState.messages).toHaveLength(1); // original unchanged
  });

  it("appends messages", () => {
    const result = applyMessagePatch(baseState, { appendMessages: [msg("2", "assistant")] });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]!.id).toBe("2");
  });

  it("returns same state for empty append", () => {
    const result = applyMessagePatch(baseState, { appendMessages: [] });
    expect(result).toBe(baseState);
  });

  it("returns same state for empty patch", () => {
    const result = applyMessagePatch(baseState, {});
    expect(result).toBe(baseState);
  });

  it("replaceMessages takes precedence over appendMessages", () => {
    const result = applyMessagePatch(baseState, {
      replaceMessages: [msg("x", "user")],
      appendMessages: [msg("y", "assistant")],
    });
    expect(result.messages).toEqual([msg("x", "user")]);
  });
});

describe("appendMessages helper", () => {
  it("creates an append patch", () => {
    const patch = appendMessages([msg("3", "tool")]);
    expect(patch).toEqual({ appendMessages: [msg("3", "tool")] });
  });
});

describe("replaceMessages helper", () => {
  it("creates a replace patch", () => {
    const patch = replaceMessages([msg("a", "user")]);
    expect(patch).toEqual({ replaceMessages: [msg("a", "user")] });
  });
});

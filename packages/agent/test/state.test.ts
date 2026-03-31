import { describe, expect, it } from "vitest";

import type { AgentState } from "../src/types";

import { AgentError } from "../src/errors";
import { applyStatePatch } from "../src/state";

const baseState: AgentState = {
  runId: "run_1",
  messages: [],
  scratchpad: {},
  memory: {},
  stepCount: 0,
  status: "running",
};

describe("applyStatePatch", () => {
  it("returns the same state when patch is undefined", () => {
    const result = applyStatePatch(baseState);
    expect(result).toEqual(baseState);
  });

  it("returns the same state when patch is empty", () => {
    const result = applyStatePatch(baseState, {});
    expect(result).toEqual(baseState);
  });

  it("appends messages", () => {
    const msg = {
      id: "m1",
      role: "user" as const,
      content: "hi",
      createdAt: "2026-01-01T00:00:00Z",
    };
    const result = applyStatePatch(baseState, { appendMessages: [msg] });
    expect(result.messages).toEqual([msg]);
    expect(baseState.messages).toEqual([]); // original unchanged
  });

  it("sets scratchpad", () => {
    const result = applyStatePatch(baseState, { setScratchpad: { key: "value" } });
    expect(result.scratchpad).toEqual({ key: "value" });
  });

  it("merges memory", () => {
    const state = { ...baseState, memory: { existing: true } };
    const result = applyStatePatch(state, { mergeMemory: { newKey: 42 } });
    expect(result.memory).toEqual({ existing: true, newKey: 42 });
  });

  it("sets status", () => {
    const result = applyStatePatch(baseState, { setStatus: "completed" });
    expect(result.status).toBe("completed");
  });

  it("sets error", () => {
    const err = new AgentError({ code: "TOOL_ERROR", message: "fail" });
    const result = applyStatePatch(baseState, { setError: err });
    expect(result.error).toBe(err);
  });

  it("applies multiple patches at once", () => {
    const result = applyStatePatch(baseState, {
      appendMessages: [
        { id: "m1", role: "user" as const, content: "hi", createdAt: "2026-01-01T00:00:00Z" },
      ],
      setStatus: "completed",
      mergeMemory: { foo: "bar" },
    });
    expect(result.messages).toHaveLength(1);
    expect(result.status).toBe("completed");
    expect(result.memory).toEqual({ foo: "bar" });
  });
});

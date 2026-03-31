import { describe, expect, it } from "vitest";

import type { AgentMessage } from "@renx/model";

import { validateMessageSequence } from "../../src/message/validator";

const msg = (
  id: string,
  role: AgentMessage["role"],
  extra?: Partial<AgentMessage>,
): AgentMessage => ({
  id,
  role,
  content: `${role} ${id}`,
  createdAt: "2026-01-01T00:00:00Z",
  ...extra,
});

describe("validateMessageSequence", () => {
  it("validates a clean sequence", () => {
    const messages: AgentMessage[] = [
      msg("1", "user"),
      msg("2", "assistant", {
        toolCalls: [{ id: "tc_1", name: "get_weather", input: { city: "Beijing" } }],
      }),
      msg("3", "tool", { toolCallId: "tc_1", name: "get_weather" }),
      msg("4", "assistant"),
    ];

    const result = validateMessageSequence(messages);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("detects duplicate message IDs", () => {
    const messages = [msg("1", "user"), msg("1", "assistant")];
    const result = validateMessageSequence(messages);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.code).toBe("DUPLICATE_MESSAGE_ID");
  });

  it("detects missing toolCallId on tool message", () => {
    const messages = [msg("1", "tool")];
    const result = validateMessageSequence(messages);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "MISSING_TOOL_CALL_ID")).toBe(true);
  });

  it("detects dangling tool call (no matching tool result)", () => {
    const messages = [
      msg("1", "user"),
      msg("2", "assistant", { toolCalls: [{ id: "tc_1", name: "get_weather", input: {} }] }),
    ];
    const result = validateMessageSequence(messages);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "DANGLING_TOOL_CALL")).toBe(true);
  });

  it("detects orphan tool result (references non-existent tool call)", () => {
    const messages = [msg("1", "tool", { toolCallId: "tc_ghost" })];
    const result = validateMessageSequence(messages);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "ORPHAN_TOOL_RESULT")).toBe(true);
  });

  it("validates an empty sequence", () => {
    const result = validateMessageSequence([]);
    expect(result.valid).toBe(true);
  });

  it("catches multiple issues at once", () => {
    const messages: AgentMessage[] = [
      msg("1", "user"),
      msg("1", "assistant"), // duplicate ID
      msg("2", "assistant", { toolCalls: [{ id: "tc_1", name: "x", input: {} }] }),
      msg("3", "tool"), // missing toolCallId
    ];

    const result = validateMessageSequence(messages);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("detects INVALID_ROLE for unknown role", () => {
    const messages = [msg("1", "unknown_role" as AgentMessage["role"])];
    const result = validateMessageSequence(messages);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "INVALID_ROLE")).toBe(true);
    expect(result.issues[0]!.message).toContain("unknown_role");
  });

  it("system role is valid", () => {
    const messages = [msg("1", "system"), msg("2", "user")];
    const result = validateMessageSequence(messages);
    expect(result.valid).toBe(true);
  });
});

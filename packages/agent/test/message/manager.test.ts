import { describe, expect, it } from "vitest";

import { DefaultMessageManager } from "../../src/message/manager";
import type { AgentState } from "../../src/types";
import type { RunMessage } from "../../src/message/types";
import { baseState } from "../helpers";

describe("DefaultMessageManager", () => {
  const mgr = new DefaultMessageManager();

  describe("normalizeIncoming", () => {
    it("normalizes user messages", () => {
      const msgs = mgr.normalizeIncoming({
        messages: [{ id: "", messageId: "", role: "user", content: "hello", createdAt: "" }],
      });
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.role).toBe("user");
      expect(msgs[0]!.content).toBe("hello");
      expect(msgs[0]!.id).toBeTruthy();
    });

    it("normalizes provided messages", () => {
      const msgs = mgr.normalizeIncoming({
        messages: [{ id: "", messageId: "", role: "user", content: "hi", createdAt: "" }],
      });
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.id).toBeTruthy();
      expect(msgs[0]!.createdAt).toBeTruthy();
    });

    it("returns empty array for empty input", () => {
      expect(mgr.normalizeIncoming({})).toEqual([]);
    });
  });

  describe("appendUserMessage", () => {
    it("appends a user message", () => {
      const result = mgr.appendUserMessage(baseState, "hello");
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]!.role).toBe("user");
      expect(result.messages[0]!.content).toBe("hello");
      expect(baseState.messages).toHaveLength(0); // immutable
    });
  });

  describe("appendAssistantMessage", () => {
    it("appends an assistant message", () => {
      const result = mgr.appendAssistantMessage(baseState, "response");
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]!.role).toBe("assistant");
    });
  });

  describe("appendAssistantToolCallMessage", () => {
    it("appends an assistant message with toolCalls", () => {
      const toolCalls = [{ id: "tc_1", name: "get_weather", input: { city: "Beijing" } }];
      const result = mgr.appendAssistantToolCallMessage(baseState, "", toolCalls);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]!.role).toBe("assistant");
      expect(result.messages[0]!.toolCalls).toEqual(toolCalls);
    });
  });

  describe("appendToolResultMessage", () => {
    it("appends a tool result message", () => {
      const result = mgr.appendToolResultMessage(
        baseState,
        "get_weather",
        "tc_1",
        '{"temp": "18°C"}',
      );
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]!.role).toBe("tool");
      expect(result.messages[0]!.toolCallId).toBe("tc_1");
      expect(result.messages[0]!.name).toBe("get_weather");
    });
  });

  describe("validate", () => {
    it("validates a correct sequence", () => {
      const msgs: RunMessage[] = [
        { id: "1", messageId: "1", role: "user", content: "hi", createdAt: "2026-01-01T00:00:00Z" },
        {
          id: "2",
          messageId: "2",
          role: "assistant",
          content: "hello",
          createdAt: "2026-01-01T00:00:01Z",
        },
      ];
      const result = mgr.validate(msgs);
      expect(result.valid).toBe(true);
    });
  });

  describe("patchToolPairs", () => {
    it("patches missing tool results", () => {
      const msgs: RunMessage[] = [
        { id: "1", messageId: "1", role: "user", content: "hi", createdAt: "2026-01-01T00:00:00Z" },
        {
          id: "2",
          messageId: "2",
          role: "assistant",
          content: "",
          createdAt: "2026-01-01T00:00:01Z",
          toolCalls: [{ id: "tc_1", name: "get_weather", input: {} }],
        },
      ];
      const result = mgr.patchToolPairs(msgs);
      expect(result.patched).toBe(true);
      expect(result.messages).toHaveLength(3);
    });
  });

  describe("buildEffectiveMessages", () => {
    it("patches tool pairs in effective messages", () => {
      const state: AgentState = {
        ...baseState,
        messages: [
          {
            id: "1",
            messageId: "1",
            role: "user",
            content: "hi",
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            id: "2",
            messageId: "2",
            role: "assistant",
            content: "",
            createdAt: "2026-01-01T00:00:01Z",
            toolCalls: [{ id: "tc_1", name: "get_weather", input: {} }],
          },
        ],
      };

      const effective = mgr.buildEffectiveMessages({
        input: {},
        identity: { userId: "u1", tenantId: "t1", roles: [] },
        state,
        services: {},
        metadata: {},
      });
      expect(effective).toHaveLength(3);
      expect(effective[2]!.role).toBe("tool");
    });

    it("applies history windowing (more than 30 messages)", () => {
      const windowedMgr = new DefaultMessageManager({ maxRecentMessages: 5 });
      const messages: RunMessage[] = Array.from({ length: 40 }, (_, i) => ({
        id: `msg_${i}`,
        messageId: `msg_${i}`,
        role: "user" as const,
        content: `message ${i}`,
        createdAt: new Date(Date.now() + i).toISOString(),
      }));

      const state: AgentState = { ...baseState, messages };
      const effective = windowedMgr.buildEffectiveMessages({
        input: {},
        identity: { userId: "u1", tenantId: "t1", roles: [] },
        state,
        services: {},
        metadata: {},
      });

      // Should keep only last 5 messages
      expect(effective).toHaveLength(5);
      expect(effective[0]!.id).toBe("msg_35");
      expect(effective[4]!.id).toBe("msg_39");
    });

    it("injects memory as a system message at the head", () => {
      const state: AgentState = {
        ...baseState,
        messages: [
          {
            id: "1",
            messageId: "1",
            role: "user",
            content: "hi",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
        memory: { userPrefs: "dark-mode", lang: "en" },
      };

      const effective = mgr.buildEffectiveMessages({
        input: {},
        identity: { userId: "u1", tenantId: "t1", roles: [] },
        state,
        services: {},
        metadata: {},
      });

      // First message should be memory injection
      expect(effective[0]!.role).toBe("system");
      expect(effective[0]!.content).toContain("[Agent Memory]");
      expect(effective[0]!.content).toContain("dark-mode");

      // Original messages follow
      expect(effective[1]!.role).toBe("user");
      expect(effective[1]!.content).toBe("hi");
    });
  });
});

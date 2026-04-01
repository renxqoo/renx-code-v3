import type { ToolCall } from "@renx/model";

import { generateId } from "../helpers";

import type { PatchToolPairsResult, RunMessage } from "./types";

/**
 * Patches assistant tool-call / tool-result pair gaps.
 *
 * Scans for assistant messages with `toolCalls` and checks whether each
 * `ToolCall.id` has a corresponding `tool`-role message with matching
 * `toolCallId`.  For any missing pair, inserts a synthetic tool result
 * message with `metadata: { synthetic: true, patchReason: "missing_tool_result" }`.
 */
export const patchToolPairs = (messages: RunMessage[]): PatchToolPairsResult => {
  // Collect all requested tool call IDs
  const requestedToolCalls = new Map<string, { toolName: string; messageIndex: number }>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "assistant" && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        requestedToolCalls.set(tc.id, { toolName: tc.name, messageIndex: i });
      }
    }
  }

  // Collect answered tool call IDs
  const answeredToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "tool" && msg.toolCallId) {
      answeredToolCallIds.add(msg.toolCallId);
    }
  }

  // Find missing pairs
  const missingIds: string[] = [];
  for (const tcId of requestedToolCalls.keys()) {
    if (!answeredToolCallIds.has(tcId)) {
      missingIds.push(tcId);
    }
  }

  if (missingIds.length === 0) {
    return { messages, patched: false, patchedToolCallIds: [] };
  }

  // Build a lookup of which tool call IDs belong to which assistant message
  const assistantToolCallsByMessage = new Map<number, ToolCall[]>();
  for (const [tcId, info] of requestedToolCalls) {
    if (missingIds.includes(tcId)) {
      const existing = assistantToolCallsByMessage.get(info.messageIndex) ?? [];
      existing.push({ id: tcId, name: info.toolName, input: undefined });
      assistantToolCallsByMessage.set(info.messageIndex, existing);
    }
  }

  // Insert synthetic tool result messages after each assistant message
  const patched: RunMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    patched.push(messages[i]!);

    const missingForThis = assistantToolCallsByMessage.get(i);
    if (missingForThis) {
      for (const tc of missingForThis) {
        patched.push(createSyntheticToolMessage(tc.id, tc.name));
      }
    }
  }

  return {
    messages: patched,
    patched: true,
    patchedToolCallIds: missingIds,
  };
};

const createSyntheticToolMessage = (toolCallId: string, toolName: string): RunMessage => ({
  id: `patch_${toolCallId}`,
  messageId: generateId("msg"),
  role: "tool",
  name: toolName,
  toolCallId,
  content: "[Synthetic tool result: missing, interrupted, or rejected]",
  createdAt: new Date().toISOString(),
  source: "framework",
  metadata: {
    synthetic: true,
    patchReason: "missing_tool_result",
  },
});

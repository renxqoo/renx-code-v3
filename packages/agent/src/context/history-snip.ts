import type { AgentMessage } from "@renx/model";

import type { RunMessage } from "../message/types";

import { groupMessagesByRound } from "./grouping";

export interface HistorySnipResult {
  apiView: AgentMessage[];
  canonicalMessages: RunMessage[];
}

export const applyHistorySnip = (
  apiView: AgentMessage[],
  canonicalMessages: RunMessage[],
  keepRounds: number,
): HistorySnipResult => {
  const groups = groupMessagesByRound(canonicalMessages);
  if (groups.length <= keepRounds) return { apiView, canonicalMessages };

  const baseKept = groups.slice(groups.length - keepRounds).flatMap((group) => group.messages);
  const atomicGroupIds = new Set(
    baseKept.map((message) => message.atomicGroupId).filter((id): id is string => Boolean(id)),
  );
  const thinkingGroupIds = new Set(
    baseKept
      .map((message) => message.thinkingChunkGroupId)
      .filter((id): id is string => Boolean(id)),
  );
  let kept = canonicalMessages.filter((message) => {
    if (baseKept.includes(message)) return true;
    if (message.atomicGroupId && atomicGroupIds.has(message.atomicGroupId)) return true;
    if (message.thinkingChunkGroupId && thinkingGroupIds.has(message.thinkingChunkGroupId))
      return true;
    return false;
  });

  // Protocol safety: if either side of tool_call/tool_result is kept,
  // keep the counterpart message to avoid producing dangling pairs.
  kept = expandWithToolPairs(kept, canonicalMessages);

  const keptIds = new Set(kept.map((message) => message.id));
  return {
    apiView: apiView.filter((message) => keptIds.has(message.id)),
    canonicalMessages: kept,
  };
};

const expandWithToolPairs = (kept: RunMessage[], all: RunMessage[]): RunMessage[] => {
  const keptIds = new Set(kept.map((message) => message.id));
  const requestedByToolCallId = new Map<string, RunMessage>();
  const resultsByToolCallId = new Map<string, RunMessage[]>();

  for (const message of all) {
    if (message.role === "assistant" && message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        requestedByToolCallId.set(toolCall.id, message);
      }
    }
    if (message.role === "tool" && message.toolCallId) {
      const list = resultsByToolCallId.get(message.toolCallId) ?? [];
      list.push(message);
      resultsByToolCallId.set(message.toolCallId, list);
    }
  }

  const queue = [...kept];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    // assistant -> ensure all tool results for requested calls are included
    if (current.role === "assistant" && current.toolCalls) {
      for (const call of current.toolCalls) {
        for (const result of resultsByToolCallId.get(call.id) ?? []) {
          if (!keptIds.has(result.id)) {
            keptIds.add(result.id);
            queue.push(result);
            kept.push(result);
          }
        }
      }
    }

    // tool_result -> ensure its assistant caller is included
    if (current.role === "tool" && current.toolCallId) {
      const caller = requestedByToolCallId.get(current.toolCallId);
      if (caller && !keptIds.has(caller.id)) {
        keptIds.add(caller.id);
        queue.push(caller);
        kept.push(caller);
      }
    }
  }

  const byId = new Set(kept.map((message) => message.id));
  return all.filter((message) => byId.has(message.id));
};

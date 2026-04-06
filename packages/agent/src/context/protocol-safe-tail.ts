import type { RunMessage } from "../message/types";

export const selectProtocolSafeSuffix = (
  messages: RunMessage[],
  desiredTailCount: number,
): RunMessage[] => {
  if (messages.length <= desiredTailCount) return messages;

  const startIndex = normalizeProtocolSafeStartIndex(
    messages,
    Math.max(0, messages.length - desiredTailCount),
  );

  return messages.slice(startIndex);
};

export const normalizeProtocolSafeStartIndex = (
  messages: RunMessage[],
  candidateStartIndex: number,
): number => {
  let startIndex = Math.max(0, Math.min(candidateStartIndex, messages.length));
  for (;;) {
    const nextStartIndex = expandStartIndex(messages, startIndex);
    if (nextStartIndex === startIndex) return startIndex;
    startIndex = nextStartIndex;
  }
};

const expandStartIndex = (messages: RunMessage[], startIndex: number): number => {
  let nextStart = startIndex;
  const kept = messages.slice(startIndex);

  const atomicGroupIds = new Set(
    kept.map((message) => message.atomicGroupId).filter((id): id is string => Boolean(id)),
  );
  const thinkingGroupIds = new Set(
    kept.map((message) => message.thinkingChunkGroupId).filter((id): id is string => Boolean(id)),
  );
  const neededToolCallIds = new Set(
    kept
      .filter((message) => message.role === "tool" && typeof message.toolCallId === "string")
      .map((message) => message.toolCallId as string),
  );

  for (const atomicGroupId of atomicGroupIds) {
    const first = messages.findIndex((message) => message.atomicGroupId === atomicGroupId);
    if (first >= 0) nextStart = Math.min(nextStart, first);
  }

  for (const thinkingGroupId of thinkingGroupIds) {
    const first = messages.findIndex((message) => message.thinkingChunkGroupId === thinkingGroupId);
    if (first >= 0) nextStart = Math.min(nextStart, first);
  }

  for (const toolCallId of neededToolCallIds) {
    const callerIndex = messages.findIndex(
      (message) =>
        message.role === "assistant" &&
        (message.toolCalls ?? []).some((toolCall) => toolCall.id === toolCallId),
    );
    if (callerIndex >= 0) nextStart = Math.min(nextStart, callerIndex);
  }

  return nextStart;
};

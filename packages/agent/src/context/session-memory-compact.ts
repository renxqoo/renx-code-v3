import type { AgentMessage } from "@renx/model";

import type { RunMessage } from "../message/types";
import { createMemorySnapshot } from "../memory";
import type { ContextRuntimeState } from "./types";
import { normalizeProtocolSafeStartIndex, selectProtocolSafeSuffix } from "./protocol-safe-tail";
import { isSessionMemoryEmpty, truncateSessionMemoryForCompact } from "./session-memory";
import { getCompactUserSummaryMessage } from "./summary-prompt";

const MIN_FRESH_WINDOW_TOKENS = 30;
const MIN_FRESH_TEXT_MESSAGES = 5;
const MAX_FRESH_WINDOW_TOKENS = 240;

const buildPreservedSegmentRelink = (
  summaryMessageId: string,
  preservedTail: RunMessage[],
): Record<string, string> | undefined => {
  if (preservedTail.length === 0) return undefined;
  return {
    headMessageId: preservedTail[0]!.id,
    anchorMessageId: summaryMessageId,
    tailMessageId: preservedTail[preservedTail.length - 1]!.id,
  };
};

export const applySessionMemoryCompact = (
  messages: AgentMessage[],
  canonicalMessages: RunMessage[],
  memory: unknown,
  state: ContextRuntimeState,
): {
  messages: AgentMessage[];
  canonicalMessages: RunMessage[];
  nextState: ContextRuntimeState;
  compactedMessageCount: number;
  boundary?: {
    boundaryId: string;
    strategy: "session_memory";
  };
  preservedSegment?: {
    segmentId: string;
    digest: string;
    summary: string;
    messageIds: string[];
    messages: RunMessage[];
  };
} => {
  const notes = state.sessionMemoryState?.notes;
  const template = state.sessionMemoryState?.template;
  if (!notes || notes.length < 20 || isSessionMemoryEmpty(notes, template)) {
    return {
      messages,
      canonicalMessages,
      nextState: state,
      compactedMessageCount: 0,
    };
  }
  if (canonicalMessages.length < 6) {
    return {
      messages,
      canonicalMessages,
      nextState: state,
      compactedMessageCount: 0,
    };
  }

  const createdAt = new Date().toISOString();
  const boundaryId = `boundary_sm_${Date.now()}`;
  const segmentId = `segment_${boundaryId}`;
  const canonicalIds = new Set(canonicalMessages.map((message) => message.id));
  const transientMessages = messages.filter((message) => !canonicalIds.has(message.id));
  const snapshot = createMemorySnapshot(
    typeof memory === "object" && memory !== null ? (memory as Record<string, unknown>) : undefined,
  );
  const transcriptPath =
    typeof snapshot.working?.mcpInstructions === "object" &&
    snapshot.working.mcpInstructions !== null &&
    "transcriptPath" in (snapshot.working.mcpInstructions as Record<string, unknown>) &&
    typeof (snapshot.working.mcpInstructions as Record<string, unknown>)["transcriptPath"] ===
      "string"
      ? ((snapshot.working.mcpInstructions as Record<string, unknown>)["transcriptPath"] as string)
      : undefined;
  const { truncatedContent } = truncateSessionMemoryForCompact(notes);
  const summaryMessage: AgentMessage = {
    id: `summary_${boundaryId}`,
    role: "system",
    createdAt,
    content: getCompactUserSummaryMessage(truncatedContent, true, transcriptPath, true),
  };

  const preservedTail = selectSessionMemoryTail(canonicalMessages, state);
  const compactedCanonical = canonicalMessages.slice(
    0,
    Math.max(0, canonicalMessages.length - preservedTail.length),
  );
  if (compactedCanonical.length === 0) {
    return {
      messages,
      canonicalMessages,
      nextState: state,
      compactedMessageCount: 0,
    };
  }
  const tail = preservedTail.map(({ messageId: _messageId, source: _source, ...message }) => ({
    ...message,
    metadata: {
      ...message.metadata,
      preservedSegmentId: segmentId,
    },
  }));
  const digest = `d_sm_${compactedCanonical.length}_${compactedCanonical.map((m) => m.id).join("|").length}`;
  const boundaryMessage: RunMessage = {
    id: `msg_${boundaryId}`,
    messageId: `msg_${boundaryId}`,
    role: "system",
    source: "framework",
    createdAt,
    content: `[Compact Boundary:${boundaryId}]\nSession memory compact applied.`,
    compactBoundary: {
      boundaryId,
      strategy: "session_memory",
      createdAt,
    },
    preservedSegmentRef: {
      segmentId,
      digest,
    },
    metadata: {
      preservedSegmentRelink: buildPreservedSegmentRelink(summaryMessage.id, preservedTail),
    },
  };
  const summaryRunMessage: RunMessage = {
    id: summaryMessage.id,
    messageId: summaryMessage.id,
    role: "system",
    source: "framework",
    createdAt,
    content: summaryMessage.content,
    preservedSegmentRef: {
      segmentId,
      digest,
    },
  };
  const preservedTailWithRefs = preservedTail.map((message) =>
    message.preservedSegmentRef
      ? message
      : {
          ...message,
          preservedSegmentRef: {
            segmentId,
            digest,
          },
        },
  );
  const nextCanonical = [boundaryMessage, summaryRunMessage, ...preservedTailWithRefs];

  return {
    messages: [...transientMessages, boundaryMessage, summaryMessage, ...tail],
    canonicalMessages: nextCanonical,
    compactedMessageCount: compactedCanonical.length,
    boundary: {
      boundaryId,
      strategy: "session_memory",
    },
    preservedSegment: {
      segmentId,
      digest,
      summary: summaryMessage.content,
      messageIds: compactedCanonical.map((m) => m.id),
      messages: preservedTailWithRefs,
    },
    nextState: {
      ...state,
      sessionMemoryState: {
        ...state.sessionMemoryState,
      },
    },
  };
};

const selectSessionMemoryTail = (
  canonicalMessages: RunMessage[],
  state: ContextRuntimeState,
): RunMessage[] => {
  const fallbackTail = selectProtocolSafeSuffix(canonicalMessages, 8);
  const lastSummarizedMessageId = state.sessionMemoryState?.lastSummarizedMessageId;
  if (lastSummarizedMessageId) {
    const lastSummarizedIndex = canonicalMessages.findIndex(
      (message) =>
        message.id === lastSummarizedMessageId || message.messageId === lastSummarizedMessageId,
    );
    if (lastSummarizedIndex >= 0 && lastSummarizedIndex + 1 < canonicalMessages.length) {
      const startIndex = normalizeProtocolSafeStartIndex(
        canonicalMessages,
        lastSummarizedIndex + 1,
      );
      return canonicalMessages.slice(expandFreshWindow(canonicalMessages, startIndex));
    }
  }

  const summarySourceRound = state.sessionMemoryState?.summarySourceRound;
  if (typeof summarySourceRound !== "number") return fallbackTail;

  const firstFreshIndex = canonicalMessages.findIndex(
    (message) => typeof message.roundIndex === "number" && message.roundIndex > summarySourceRound,
  );
  if (firstFreshIndex < 0) return fallbackTail;

  const fallbackStart = canonicalMessages.length - fallbackTail.length;
  const desiredStart = Math.min(firstFreshIndex, fallbackStart);
  let startIndex = normalizeProtocolSafeStartIndex(canonicalMessages, desiredStart);

  if (firstFreshIndex > fallbackStart) {
    startIndex = expandFreshWindow(canonicalMessages, startIndex);
  }

  return canonicalMessages.slice(startIndex);
};

const expandFreshWindow = (messages: RunMessage[], startIndex: number): number => {
  let nextStart = startIndex;
  let totalTokens = 0;
  let textMessageCount = 0;

  for (let i = startIndex; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message) continue;
    totalTokens += estimateMessageTokens(message);
    if (isTextMessage(message)) {
      textMessageCount += 1;
    }
  }

  if (totalTokens >= MIN_FRESH_WINDOW_TOKENS && textMessageCount >= MIN_FRESH_TEXT_MESSAGES) {
    return nextStart;
  }

  for (let i = startIndex - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    const messageTokens = estimateMessageTokens(message);
    if (totalTokens + messageTokens > MAX_FRESH_WINDOW_TOKENS && textMessageCount > 0) {
      break;
    }
    nextStart = i;
    totalTokens += messageTokens;
    if (isTextMessage(message)) {
      textMessageCount += 1;
    }
    if (totalTokens >= MIN_FRESH_WINDOW_TOKENS && textMessageCount >= MIN_FRESH_TEXT_MESSAGES) {
      break;
    }
  }

  return normalizeProtocolSafeStartIndex(messages, nextStart);
};

const estimateMessageTokens = (message: RunMessage): number =>
  Math.max(1, Math.ceil(message.content.length / 4));

const isTextMessage = (message: RunMessage): boolean =>
  (message.role === "user" || message.role === "assistant") && message.content.trim().length > 0;

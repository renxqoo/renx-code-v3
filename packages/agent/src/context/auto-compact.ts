import type { AgentMessage } from "@renx/model";

import type { RunMessage } from "../message/types";
import { groupMessagesByRound } from "./grouping";

export interface AutoCompactResult {
  apiView: AgentMessage[];
  canonicalMessages: RunMessage[];
  compactedMessageCount: number;
  preservedSegment?: {
    segmentId: string;
    digest: string;
    summary: string;
    messageIds: string[];
  };
  boundary?: {
    boundaryId: string;
    strategy: "auto_compact" | "reactive_compact";
  };
}

export const applyAutoCompact = (
  apiView: AgentMessage[],
  canonicalMessages: RunMessage[],
  strategy: "auto_compact" | "reactive_compact",
  options?: {
    maxCompactRequestRetries?: number;
    compactRequestMaxInputChars?: number;
    historySnipMaxDropRounds?: number;
  },
): AutoCompactResult => {
  if (canonicalMessages.length < 6) {
    return { apiView, canonicalMessages, compactedMessageCount: 0 };
  }

  const createdAt = new Date().toISOString();
  const compactInput = prepareCompactInput(canonicalMessages, options);
  const compacted = compactInput.slice(0, Math.max(1, compactInput.length - 8));
  const preservedTail = compactInput.slice(compacted.length);
  const boundaryId = `boundary_${Date.now()}`;
  const segmentId = `segment_${boundaryId}`;
  const digest = buildSegmentDigest(compacted);

  const summaryLines = compacted
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-6)
    .map((message) => `${message.role}: ${message.content.slice(0, 120)}`);

  const summaryBody = buildCompactionSeed(compacted);

  const boundaryMessage: RunMessage = {
    id: `msg_${boundaryId}`,
    messageId: `msg_${boundaryId}`,
    role: "system",
    source: "framework",
    createdAt,
    content: `[Compact Boundary:${boundaryId}]\n${summaryLines.join("\n")}`,
    compactBoundary: {
      boundaryId,
      strategy: strategy === "auto_compact" ? "auto_compact" : "reactive_compact",
      createdAt,
    },
    preservedSegmentRef: {
      segmentId,
      digest,
    },
  };

  const summaryMessage: RunMessage = {
    id: `summary_${boundaryId}`,
    messageId: `summary_${boundaryId}`,
    role: "system",
    source: "framework",
    createdAt,
    content: `[Compact Summary:${segmentId}]\n${summaryBody}`,
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

  const nextCanonical = [boundaryMessage, summaryMessage, ...preservedTailWithRefs];
  const keptIds = new Set(nextCanonical.map((message) => message.id));
  const nextApiView = [
    boundaryMessage,
    summaryMessage,
    ...apiView.filter((message) => keptIds.has(message.id)),
  ];
  return {
    apiView: nextApiView,
    canonicalMessages: nextCanonical,
    compactedMessageCount: compacted.length,
    boundary: {
      boundaryId,
      strategy,
    },
    preservedSegment: {
      segmentId,
      digest,
      summary: summaryBody,
      messageIds: compacted.map((m) => m.id),
    },
  };
};

const buildCompactionSeed = (messages: RunMessage[]): string => {
  const excerpt = messages
    .slice(-24)
    .map((m) => {
      const role =
        m.role === "assistant" || m.role === "user" || m.role === "tool" ? m.role : "system";
      return `${role}: ${m.content.slice(0, 220)}`;
    })
    .join("\n");
  const paths = messages.flatMap((m) => extractLikelyPaths(m.content)).slice(-8);
  const pathBlock =
    paths.length > 0 ? `\nLikely paths:\n${paths.map((p) => `- ${p}`).join("\n")}` : "";
  return `Compaction seed for model summarization:\n${excerpt}${pathBlock}`;
};

const extractLikelyPaths = (content: string): string[] => {
  const matches = content.match(/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+/g);
  return matches ?? [];
};

const buildSegmentDigest = (messages: RunMessage[]): string => {
  const ids = messages.map((m) => m.id).join("|");
  return `d_${ids.length}_${messages.length}`;
};

export const trimOldestRoundGroups = (
  messages: RunMessage[],
  maxDropRounds: number,
): RunMessage[] => {
  const grouped = groupMessagesByRound(messages);
  if (grouped.length <= 1) return messages;
  const drop = Math.min(Math.max(1, maxDropRounds), grouped.length - 1);
  return grouped.slice(drop).flatMap((group) => group.messages);
};

const prepareCompactInput = (
  messages: RunMessage[],
  options?: {
    maxCompactRequestRetries?: number;
    compactRequestMaxInputChars?: number;
    historySnipMaxDropRounds?: number;
  },
): RunMessage[] => {
  const maxRetries = options?.maxCompactRequestRetries ?? 0;
  const maxChars = options?.compactRequestMaxInputChars ?? Number.MAX_SAFE_INTEGER;
  const dropRounds = options?.historySnipMaxDropRounds ?? 1;

  let working = messages;
  for (let retry = 0; retry <= maxRetries; retry += 1) {
    const size = working.reduce((sum, message) => sum + message.content.length, 0);
    if (size <= maxChars) return working;
    const next = trimOldestRoundGroups(working, dropRounds);
    if (next.length >= working.length) return working;
    working = next;
  }
  return working;
};

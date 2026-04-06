import type { AgentMessage } from "@renx/model";

import type { RunMessage } from "../message/types";
import { groupMessagesByRound } from "./grouping";
import { selectProtocolSafeSuffix } from "./protocol-safe-tail";

export interface AutoCompactResult {
  apiView: AgentMessage[];
  canonicalMessages: RunMessage[];
  compactedMessageCount: number;
  preservedSegment?: {
    segmentId: string;
    digest: string;
    summary: string;
    messageIds: string[];
    messages: RunMessage[];
  };
  boundary?: {
    boundaryId: string;
    strategy: "auto_compact" | "reactive_compact" | "manual_compact";
  };
}

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

export const applyAutoCompact = (
  apiView: AgentMessage[],
  canonicalMessages: RunMessage[],
  strategy: "auto_compact" | "reactive_compact" | "manual_compact",
  options?: {
    maxCompactRequestRetries?: number;
    compactRequestMaxInputChars?: number;
    historySnipMaxDropRounds?: number;
    customInstructions?: string;
  },
): AutoCompactResult => {
  if (canonicalMessages.length < 6) {
    return { apiView, canonicalMessages, compactedMessageCount: 0 };
  }

  const createdAt = new Date().toISOString();
  const compactInput = prepareCompactInput(canonicalMessages, options);
  const preservedTail = selectProtocolSafeSuffix(compactInput, 8);
  const compacted = compactInput.slice(0, Math.max(0, compactInput.length - preservedTail.length));
  if (compacted.length === 0) {
    return { apiView, canonicalMessages, compactedMessageCount: 0 };
  }
  const boundaryId = `boundary_${Date.now()}`;
  const segmentId = `segment_${boundaryId}`;
  const digest = buildSegmentDigest(compacted);

  const summaryLines = compacted
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-6)
    .map((message) => `${message.role}: ${message.content.slice(0, 120)}`);

  const summaryBody = buildCompactionSeed(compacted, options?.customInstructions);

  const boundaryMessage: RunMessage = {
    id: `msg_${boundaryId}`,
    messageId: `msg_${boundaryId}`,
    role: "system",
    source: "framework",
    createdAt,
    content: `[Compact Boundary:${boundaryId}]\n${summaryLines.join("\n")}`,
    compactBoundary: {
      boundaryId,
      strategy,
      createdAt,
    },
    preservedSegmentRef: {
      segmentId,
      digest,
    },
    metadata: {
      preservedSegmentRelink: buildPreservedSegmentRelink(`summary_${boundaryId}`, preservedTail),
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
    metadata: {
      compactSource: compacted.map((message) => `${message.role}: ${message.content}`).join("\n\n"),
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
  const canonicalIds = new Set(canonicalMessages.map((message) => message.id));
  const transientMessages = apiView.filter((message) => !canonicalIds.has(message.id));
  const canonicalApiView = nextCanonical.map(
    ({ messageId: _messageId, source: _source, ...msg }) => msg,
  );
  const nextApiView = [...transientMessages, ...canonicalApiView];
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
      messages: preservedTailWithRefs,
    },
  };
};

const buildCompactionSeed = (messages: RunMessage[], customInstructions?: string): string => {
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
  const instructionBlock = customInstructions
    ? `\nCompact instructions:\n${customInstructions}`
    : "";
  return `Compaction seed for model summarization:\n${excerpt}${pathBlock}${instructionBlock}`;
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

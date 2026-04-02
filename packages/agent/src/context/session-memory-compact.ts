import type { AgentMessage } from "@renx/model";

import type { RunMessage } from "../message/types";
import type { ContextRuntimeState } from "./types";

export const applySessionMemoryCompact = (
  messages: AgentMessage[],
  canonicalMessages: RunMessage[],
  memory: Record<string, unknown>,
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
  };
} => {
  const summaryFromMemory =
    typeof memory.sessionSummary === "string" ? memory.sessionSummary : undefined;
  const summary =
    summaryFromMemory ??
    state.sessionMemoryState?.hotSummaryText ??
    state.sessionMemoryState?.coldSummaryText;
  const coldSummary = state.sessionMemoryState?.coldSummaryText;
  if (!summary || summary.length < 20) {
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
  const summaryMessage: AgentMessage = {
    id: `summary_${boundaryId}`,
    role: "system",
    createdAt,
    content:
      coldSummary && coldSummary !== summary
        ? `[Session Memory Compact:${segmentId}]\n## Hot\n${summary}\n\n## Cold\n${coldSummary}`
        : `[Session Memory Compact:${segmentId}]\n${summary}`,
  };

  const tail = messages.slice(-8).map((message) => ({
    ...message,
    metadata: {
      ...message.metadata,
      preservedSegmentId: segmentId,
    },
  }));
  const compactedCanonical = canonicalMessages.slice(0, Math.max(1, canonicalMessages.length - 8));
  const preservedTail = canonicalMessages.slice(compactedCanonical.length);
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
    messages: [boundaryMessage, summaryMessage, ...tail],
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
    },
    nextState: {
      ...state,
      sessionMemoryState: {
        lastSummaryAt: new Date().toISOString(),
        summarySourceRound: state.roundIndex,
        hotSummaryText: summary,
        coldSummaryText: coldSummary ?? summary,
        ...(coldSummary ? {} : { lastColdSummaryAt: new Date().toISOString() }),
      },
    },
  };
};

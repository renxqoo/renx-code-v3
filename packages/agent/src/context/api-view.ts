import type { AgentMessage } from "@renx/model";

import type { RunMessage } from "../message/types";
import type { ContextRuntimeState } from "./types";

export const projectApiView = (
  effectiveMessages: AgentMessage[],
  canonicalMessages: RunMessage[],
  state?: ContextRuntimeState,
): { apiView: AgentMessage[]; canonical: RunMessage[] } => {
  const latestBoundaryIndex = findLatestBoundaryIndex(canonicalMessages);
  if (latestBoundaryIndex < 0) {
    return {
      apiView: effectiveMessages,
      canonical: canonicalMessages,
    };
  }

  const canonicalFromBoundary = canonicalMessages.slice(latestBoundaryIndex);
  const canonicalIds = new Set(canonicalMessages.map((message) => message.id));
  const allowedIds = new Set(canonicalFromBoundary.map((message) => message.id));

  // Keep boundary-tail messages plus transient injected context (e.g. memory)
  // that exists only in effective view.
  const apiView = effectiveMessages.filter((message) => {
    if (allowedIds.has(message.id)) return true;
    return !canonicalIds.has(message.id);
  });

  const canonicalWithRelinkedTail = restoreCanonicalMessages(canonicalFromBoundary, state);
  const transientMessages = apiView.filter((message) => !canonicalIds.has(message.id));
  const canonicalApiView = canonicalWithRelinkedTail.map(
    ({ messageId: _messageId, source: _source, ...msg }) => msg,
  );

  return {
    apiView: [...transientMessages, ...canonicalApiView],
    canonical: canonicalWithRelinkedTail,
  };
};

export const restoreCanonicalMessages = (
  canonical: RunMessage[],
  state?: ContextRuntimeState,
): RunMessage[] => {
  const canonicalWithRestoredSummary = restoreSummaryFromPreservedSegment(canonical, state);
  return restorePreservedTailFromSegment(canonicalWithRestoredSummary, state);
};

const findLatestBoundaryIndex = (messages: RunMessage[]): number => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.compactBoundary) return i;
  }
  return -1;
};

const restoreSummaryFromPreservedSegment = (
  canonical: RunMessage[],
  state?: ContextRuntimeState,
): RunMessage[] => {
  if (!state || canonical.length === 0) return canonical;
  const hasSummary = canonical.some(
    (m) => m.id.startsWith("summary_") || m.id.startsWith("restored_summary_"),
  );
  if (hasSummary) return canonical;
  const boundary = canonical[0];
  const segmentId = boundary?.preservedSegmentRef?.segmentId;
  if (!segmentId) return canonical;
  const preserved = state.preservedSegments?.[segmentId];
  if (!preserved) return canonical;

  const summary: RunMessage = {
    id: `restored_summary_${segmentId}`,
    messageId: `restored_summary_${segmentId}`,
    role: "system",
    source: "framework",
    createdAt: new Date().toISOString(),
    content: `[Restored Compact Summary:${segmentId}]\n${preserved.summary}`,
    preservedSegmentRef: {
      segmentId,
      digest: preserved.digest,
    },
  };
  return [canonical[0]!, summary, ...canonical.slice(1)];
};

const restorePreservedTailFromSegment = (
  canonical: RunMessage[],
  state?: ContextRuntimeState,
): RunMessage[] => {
  if (!state || canonical.length === 0) return canonical;
  const boundary = canonical[0];
  const segmentId = boundary?.preservedSegmentRef?.segmentId;
  if (!segmentId) return canonical;

  const relink = boundary?.metadata?.["preservedSegmentRelink"];
  if (!relink || typeof relink !== "object") return canonical;

  const preserved = state.preservedSegments?.[segmentId];
  if (!preserved?.messages || preserved.messages.length === 0) return canonical;

  const relinkInfo = relink as {
    headMessageId?: string;
    anchorMessageId?: string;
    tailMessageId?: string;
  };
  const storedTail = sliceStoredTail(preserved.messages, relinkInfo);
  if (storedTail.length === 0) return canonical;

  const summaryIndex = canonical.findIndex(
    (message) =>
      message.id === relinkInfo.anchorMessageId ||
      message.id.startsWith("summary_") ||
      message.id.startsWith("restored_summary_"),
  );
  const insertIndex = summaryIndex >= 0 ? summaryIndex + 1 : 1;
  const prefix = canonical.slice(0, insertIndex);
  const suffix = canonical.slice(insertIndex);
  const suffixById = new Map(suffix.map((message) => [message.id, message]));
  const storedTailIds = new Set(storedTail.map((message) => message.id));
  const orderedTail = storedTail.map((message) => suffixById.get(message.id) ?? message);
  const remainingSuffix = suffix.filter((message) => !storedTailIds.has(message.id));

  return [...prefix, ...orderedTail, ...remainingSuffix];
};

const sliceStoredTail = (
  messages: RunMessage[],
  relink: {
    headMessageId?: string;
    tailMessageId?: string;
  },
): RunMessage[] => {
  const headIndex = relink.headMessageId
    ? messages.findIndex((message) => message.id === relink.headMessageId)
    : -1;
  const tailIndex = relink.tailMessageId
    ? messages.findIndex((message) => message.id === relink.tailMessageId)
    : -1;

  if (headIndex < 0 || tailIndex < 0 || tailIndex < headIndex) {
    return dedupeMessagesById(messages);
  }

  return dedupeMessagesById(messages.slice(headIndex, tailIndex + 1));
};

const dedupeMessagesById = (messages: RunMessage[]): RunMessage[] => {
  const seen = new Set<string>();
  const deduped: RunMessage[] = [];

  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    deduped.push(message);
  }

  return deduped;
};

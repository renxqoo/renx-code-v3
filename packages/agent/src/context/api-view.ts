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

  const canonicalWithRestoredSummary = restoreSummaryFromPreservedSegment(
    canonicalFromBoundary,
    state,
  );
  const restoredSummaryIds = new Set(canonicalWithRestoredSummary.map((m) => m.id));
  const apiWithSummary = [
    ...canonicalWithRestoredSummary
      .filter((m) => m.role === "system" && m.id.startsWith("restored_summary_"))
      .map(({ messageId: _messageId, source: _source, ...msg }) => msg),
    ...apiView.filter((m) => restoredSummaryIds.has(m.id) || !canonicalIds.has(m.id)),
  ];

  return {
    apiView: apiWithSummary,
    canonical: canonicalWithRestoredSummary,
  };
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
  const hasSummary = canonical.some((m) => m.id.startsWith("summary_"));
  if (hasSummary) return canonical;
  const boundary = canonical[0];
  const segmentId = boundary?.preservedSegmentRef?.segmentId;
  if (!segmentId) return canonical;
  const preserved = state.preservedSegments[segmentId];
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

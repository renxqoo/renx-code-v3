import type { ContextRuntimeState } from "./types";

export const appendCompactBoundary = (
  state: ContextRuntimeState,
  boundary: {
    boundaryId: string;
    strategy: "session_memory" | "auto_compact" | "reactive_compact";
  },
  compactedMessageCount: number,
): ContextRuntimeState => {
  const parent = state.compactBoundaries[state.compactBoundaries.length - 1];
  return {
    ...state,
    compactBoundaries: [
      ...state.compactBoundaries,
      {
        boundaryId: boundary.boundaryId,
        ...(parent ? { parentBoundaryId: parent.boundaryId } : {}),
        strategy: boundary.strategy,
        createdAt: new Date().toISOString(),
        compactedMessageCount,
      },
    ],
  };
};

export const storePreservedSegment = (
  state: ContextRuntimeState,
  segment: {
    segmentId: string;
    digest: string;
    summary: string;
    messageIds: string[];
  },
): ContextRuntimeState => {
  return {
    ...state,
    preservedSegments: {
      ...state.preservedSegments,
      [segment.segmentId]: {
        digest: segment.digest,
        summary: segment.summary,
        messageIds: segment.messageIds,
        createdAt: new Date().toISOString(),
      },
    },
  };
};

export const loadPreservedSegment = (
  state: ContextRuntimeState,
  segmentId: string,
): { digest: string; summary: string; messageIds: string[]; createdAt: string } | undefined => {
  return state.preservedSegments[segmentId];
};

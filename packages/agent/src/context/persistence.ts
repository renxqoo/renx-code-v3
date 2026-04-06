import type { ContextRuntimeState } from "./types";

export const appendCompactBoundary = (
  state: ContextRuntimeState,
  boundary: {
    boundaryId: string;
    strategy: "session_memory" | "auto_compact" | "reactive_compact" | "manual_compact";
  },
  compactedMessageCount: number,
): ContextRuntimeState => {
  const compactBoundaries = state.compactBoundaries ?? [];
  const parent = compactBoundaries[compactBoundaries.length - 1];
  return {
    ...state,
    compactBoundaries: [
      ...compactBoundaries,
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
    messages?: import("../message/types").RunMessage[];
  },
): ContextRuntimeState => {
  return {
    ...state,
    preservedSegments: {
      ...(state.preservedSegments ?? {}),
      [segment.segmentId]: {
        digest: segment.digest,
        summary: segment.summary,
        messageIds: segment.messageIds,
        ...(segment.messages ? { messages: segment.messages } : {}),
        createdAt: new Date().toISOString(),
      },
    },
  };
};

export const loadPreservedSegment = (
  state: ContextRuntimeState,
  segmentId: string,
):
  | {
      digest: string;
      summary: string;
      messageIds: string[];
      messages?: import("../message/types").RunMessage[];
      createdAt: string;
    }
  | undefined => {
  return state.preservedSegments?.[segmentId];
};

export const recordCompactionDiagnostic = (
  state: ContextRuntimeState,
  diagnostic: Omit<
    import("./types").ContextCompactionDiagnostic,
    "diagnosticId" | "createdAt" | "rehydratedAssetIds"
  > & {
    diagnosticId?: string;
    createdAt?: string;
    rehydratedAssetIds?: string[];
  },
): ContextRuntimeState => {
  const createdAt = diagnostic.createdAt ?? new Date().toISOString();
  const compactionDiagnostics = state.compactionDiagnostics ?? [];
  const diagnosticId =
    diagnostic.diagnosticId ?? `cmp_${Date.now()}_${compactionDiagnostics.length}`;
  const next = {
    ...diagnostic,
    diagnosticId,
    createdAt,
    rehydratedAssetIds: diagnostic.rehydratedAssetIds ?? [],
  };
  return {
    ...state,
    compactionDiagnostics: [...compactionDiagnostics, next].slice(-50),
    pendingPostCompactLifecycle: {
      diagnosticId,
      strategy: diagnostic.strategy,
      source: diagnostic.source,
      createdAt,
      ...(diagnostic.boundaryId ? { boundaryId: diagnostic.boundaryId } : {}),
    },
  };
};

export const markPostCompactTurnStarted = (
  state: ContextRuntimeState,
  startedAt = new Date().toISOString(),
): ContextRuntimeState => {
  const pending = state.pendingPostCompactLifecycle;
  if (!pending || pending.startedAt) return state;
  return {
    ...state,
    pendingPostCompactLifecycle: {
      ...pending,
      startedAt,
    },
  };
};

export const clearPendingPostCompactLifecycle = (
  state: ContextRuntimeState,
): ContextRuntimeState => {
  const { pendingPostCompactLifecycle: _pending, ...rest } = state;
  return rest;
};

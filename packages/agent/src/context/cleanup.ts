import type { ContextRuntimeState } from "./types";

export const runPostCompactCleanup = (state: ContextRuntimeState): ContextRuntimeState => {
  const { contextCollapseState: _collapseState, ...restState } = state;
  const retainedRefs = Object.keys(state.toolResultCache).slice(-50);
  const evictedRefs = Object.keys(state.toolResultCache).slice(
    0,
    Math.max(0, Object.keys(state.toolResultCache).length - 50),
  );
  const nextCache: Record<string, string> = {};
  for (const ref of retainedRefs) {
    const value = state.toolResultCache[ref];
    if (value !== undefined) nextCache[ref] = value;
  }

  return {
    ...restState,
    consecutiveCompactFailures: 0,
    toolResultCache: nextCache,
    toolResultStorageState: {
      cachedRefs: retainedRefs,
      evictedRefs,
    },
  };
};

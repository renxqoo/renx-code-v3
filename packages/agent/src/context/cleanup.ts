import type { ContextRuntimeState } from "./types";

export const runPostCompactCleanup = (
  state: ContextRuntimeState,
  querySource?: string,
): ContextRuntimeState => {
  const shouldResetCollapse =
    !querySource ||
    querySource === "compact" ||
    querySource === "sdk" ||
    querySource.startsWith("repl_main_thread");
  const { contextCollapseState: collapseState, ...restState } = state;
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
    ...(shouldResetCollapse ? {} : { contextCollapseState: collapseState }),
    consecutiveCompactFailures: 0,
    toolResultCache: nextCache,
    toolResultStorageState: {
      cachedRefs: retainedRefs,
      evictedRefs,
    },
  };
};

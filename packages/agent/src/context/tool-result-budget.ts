import type { AgentMessage } from "@renx/model";

import type { ContextManagerConfig, ContextRuntimeState } from "./types";

export interface ToolResultBudgetResult {
  messages: AgentMessage[];
  nextState: ContextRuntimeState;
}

export const applyToolResultBudget = (
  messages: AgentMessage[],
  state: ContextRuntimeState,
  config: ContextManagerConfig,
): ToolResultBudgetResult => {
  const toolResultCache = { ...state.toolResultCache };

  const normalized = messages.map((message) => {
    if (message.role !== "tool") return message;
    if (message.content.length <= config.toolResultSoftCharLimit) return message;

    const refKey = message.id;
    const existingRaw = toolResultCache[refKey];
    const hydratedFromCache = message.metadata?.["hydratedFromCache"] === true;
    toolResultCache[refKey] =
      hydratedFromCache && typeof existingRaw === "string" ? existingRaw : message.content;
    return {
      ...message,
      content: `[tool_result_cache_ref:${refKey}] tool result compacted due to budget`,
    };
  });

  return {
    messages: normalized,
    nextState: {
      ...state,
      toolResultCache,
      toolResultStorageState: {
        cachedRefs: Object.keys(toolResultCache),
        evictedRefs: state.toolResultStorageState?.evictedRefs ?? [],
      },
    },
  };
};

export const hydrateToolResultCacheRefs = (
  messages: AgentMessage[],
  state: ContextRuntimeState,
  maxHydratedChars = 1_500,
): AgentMessage[] => {
  return messages.map((message) => {
    if (message.role !== "tool") return message;
    const match = message.content.match(/\[tool_result_cache_ref:([^\]]+)\]/);
    if (!match) return message;
    const refKey = match[1];
    if (!refKey) return message;
    const raw = state.toolResultCache[refKey];
    if (!raw) return message;
    const hydrated = raw.slice(0, maxHydratedChars);
    return {
      ...message,
      content: `${hydrated}${raw.length > maxHydratedChars ? "\n...[hydrated from cache]" : ""}`,
      metadata: {
        ...message.metadata,
        hydratedFromCache: true,
      },
    };
  });
};

import type { AgentMessage, ModelResponse, TokenUsage, ToolDefinition } from "@renx/model";

import type { RunMessage } from "../message/types";

import { applyAutoCompact } from "./auto-compact";
import { projectApiView } from "./api-view";
import { estimateInputTokens } from "./budget";
import { runPostCompactCleanup } from "./cleanup";
import { applyContextCollapse, restoreCollapsedContext } from "./context-collapse";
import { applyHistorySnip } from "./history-snip";
import { applyMicrocompact } from "./microcompact";
import { recoverFromContextError } from "./recovery";
import { buildRehydrationHints } from "./rehydration";
import { stripMediaFromMessages } from "./media-strip";
import { applySessionMemoryCompact } from "./session-memory-compact";
import { buildBudgetSnapshot } from "./thresholds";
import { applyToolResultBudget, hydrateToolResultCacheRefs } from "./tool-result-budget";
import { appendCompactBoundary, storePreservedSegment } from "./persistence";
import type {
  ContextErrorRecoveryResult,
  ContextManagerConfig,
  ContextPrepareResult,
  ContextRuntimeState,
} from "./types";

const defaultConfig: ContextManagerConfig = {
  maxInputTokens: 96_000,
  maxOutputTokens: 8_000,
  maxPromptTooLongRetries: 3,
  maxReactiveCompactAttempts: 3,
  maxCompactRequestRetries: 2,
  compactRequestMaxInputChars: 20_000,
  maxConsecutiveCompactFailures: 3,
  toolResultSoftCharLimit: 6_000,
  historySnipKeepRounds: 50,
  historySnipMaxDropRounds: 10,
  microcompactMaxToolChars: 1_500,
  collapseRestoreMaxMessages: 8,
  collapseRestoreTokenHeadroomRatio: 0.6,
  rehydrationTokenBudget: 50_000,
  recentFileBudgetTokens: 5_000,
  skillsRehydrateBudgetTokens: 25_000,
  thresholds: {
    warningBufferTokens: 20_000,
    autoCompactBufferTokens: 13_000,
    errorBufferTokens: 20_000,
    blockingHeadroomTokens: 3_000,
  },
};

export const initialContextRuntimeState = (): ContextRuntimeState => ({
  roundIndex: 0,
  lastLayerExecutions: [],
  consecutiveCompactFailures: 0,
  promptTooLongRetries: 0,
  toolResultCache: {},
  preservedSegments: {},
  compactBoundaries: [],
  toolResultStorageState: {
    cachedRefs: [],
    evictedRefs: [],
  },
  sessionMemoryState: {},
});

export class ContextOrchestrator {
  private readonly config: ContextManagerConfig;

  constructor(config?: Partial<ContextManagerConfig>) {
    this.config = {
      ...defaultConfig,
      ...config,
      thresholds: {
        ...defaultConfig.thresholds,
        ...config?.thresholds,
      },
    };
  }

  prepare(input: {
    systemPrompt: string;
    tools: ToolDefinition[];
    apiView: AgentMessage[];
    canonicalMessages: RunMessage[];
    memory: Record<string, unknown>;
    contextState?: ContextRuntimeState;
  }): ContextPrepareResult {
    let state = input.contextState ?? initialContextRuntimeState();
    if (this.shouldTripCompactBreaker(state)) {
      const estimated = estimateInputTokens({
        systemPrompt: input.systemPrompt,
        messages: input.apiView,
        tools: input.tools,
        state,
      });
      const breakerBudget = buildBudgetSnapshot(estimated, this.config);
      breakerBudget.shouldBlock = true;
      return {
        messages: input.apiView,
        canonicalMessages: input.canonicalMessages,
        nextState: state,
        budget: breakerBudget,
      };
    }

    const projected = projectApiView(input.apiView, input.canonicalMessages, state);
    let apiView = hydrateToolResultCacheRefs(projected.apiView, state);
    let canonicalMessages = projected.canonical;
    const layerExecutions = [...state.lastLayerExecutions];

    const mediaStripped = stripMediaFromMessages(apiView);
    if (mediaStripped.some((msg, idx) => msg.content !== apiView[idx]?.content)) {
      layerExecutions.push({
        layer: "media_stripping",
        beforeTokens: 0,
        afterTokens: 0,
        reason: "Replace image/document payloads before compression",
      });
      apiView = mediaStripped;
    }

    const beforeBudgetTokens = estimateInputTokens({
      systemPrompt: input.systemPrompt,
      messages: apiView,
      tools: input.tools,
      state,
    });

    const budget = buildBudgetSnapshot(beforeBudgetTokens, this.config);

    // Layer 0: tool result budget.
    const toolBudgeted = applyToolResultBudget(apiView, state, this.config);
    apiView = toolBudgeted.messages;
    state = toolBudgeted.nextState;
    layerExecutions.push({
      layer: "tool_result_budget",
      beforeTokens: beforeBudgetTokens,
      afterTokens: estimateInputTokens({
        systemPrompt: input.systemPrompt,
        messages: apiView,
        tools: input.tools,
        state,
      }),
      reason: "Always enforce tool result soft budget",
    });

    if (!budget.requiresAutoCompact) {
      const tokenHeadroom = Math.max(0, budget.autoCompactThreshold - budget.estimatedInputTokens);
      const restoreTokenBudget = Math.floor(
        tokenHeadroom * clamp01(this.config.collapseRestoreTokenHeadroomRatio),
      );
      const restored = restoreCollapsedContext(
        apiView,
        state,
        this.config.collapseRestoreMaxMessages,
        restoreTokenBudget,
      );
      if (restored.restored) {
        apiView = restored.messages;
        state = restored.nextState;
        layerExecutions.push({
          layer: "context_collapse",
          beforeTokens: beforeBudgetTokens,
          afterTokens: estimateInputTokens({
            systemPrompt: input.systemPrompt,
            messages: apiView,
            tools: input.tools,
            state,
          }),
          reason: "Restore collapsed context when budget is healthy",
        });
      }
    }

    if (budget.requiresAutoCompact) {
      const snipped = applyHistorySnip(
        apiView,
        canonicalMessages,
        this.config.historySnipKeepRounds,
      );
      apiView = snipped.apiView;
      canonicalMessages = snipped.canonicalMessages;
      layerExecutions.push({
        layer: "history_snip",
        beforeTokens: budget.estimatedInputTokens,
        afterTokens: estimateInputTokens({
          systemPrompt: input.systemPrompt,
          messages: apiView,
          tools: input.tools,
          state,
        }),
        reason: "Crossed auto compact threshold",
      });

      apiView = applyMicrocompact(apiView, this.config.microcompactMaxToolChars, state.roundIndex);
      layerExecutions.push({
        layer: "microcompact",
        beforeTokens: budget.estimatedInputTokens,
        afterTokens: estimateInputTokens({
          systemPrompt: input.systemPrompt,
          messages: apiView,
          tools: input.tools,
          state,
        }),
        reason: "Compact cold tool outputs",
      });

      const collapsed = applyContextCollapse(apiView, state);
      apiView = collapsed.messages;
      state = collapsed.nextState;
      layerExecutions.push({
        layer: "context_collapse",
        beforeTokens: budget.estimatedInputTokens,
        afterTokens: estimateInputTokens({
          systemPrompt: input.systemPrompt,
          messages: apiView,
          tools: input.tools,
          state,
        }),
        reason: "Fold middle history band",
      });

      const sessionCompacted = applySessionMemoryCompact(
        apiView,
        canonicalMessages,
        input.memory,
        state,
      );
      apiView = sessionCompacted.messages;
      canonicalMessages = sessionCompacted.canonicalMessages;
      state = sessionCompacted.nextState;
      if (sessionCompacted.compactedMessageCount > 0 && sessionCompacted.boundary) {
        state = appendCompactBoundary(
          state,
          sessionCompacted.boundary,
          sessionCompacted.compactedMessageCount,
        );
        if (sessionCompacted.preservedSegment) {
          state = storePreservedSegment(state, sessionCompacted.preservedSegment);
        }
        state = runPostCompactCleanup(state);
      }
      layerExecutions.push({
        layer: "session_memory_compact",
        beforeTokens: budget.estimatedInputTokens,
        afterTokens: estimateInputTokens({
          systemPrompt: input.systemPrompt,
          messages: apiView,
          tools: input.tools,
          state,
        }),
        reason: "Fast path from session memory",
      });

      const postLightBudget = estimateInputTokens({
        systemPrompt: input.systemPrompt,
        messages: apiView,
        tools: input.tools,
        state,
      });

      if (postLightBudget >= budget.errorThreshold) {
        const beforeCanonicalLength = canonicalMessages.length;
        const compacted = applyAutoCompact(apiView, canonicalMessages, "auto_compact", {
          maxCompactRequestRetries: this.config.maxCompactRequestRetries,
          compactRequestMaxInputChars: this.config.compactRequestMaxInputChars,
          historySnipMaxDropRounds: this.config.historySnipMaxDropRounds,
        });
        apiView = compacted.apiView;
        canonicalMessages = compacted.canonicalMessages;
        if (compacted.compactedMessageCount > 0 && compacted.boundary) {
          state = appendCompactBoundary(state, compacted.boundary, compacted.compactedMessageCount);
          if (compacted.preservedSegment) {
            state = storePreservedSegment(state, compacted.preservedSegment);
          }
          state = runPostCompactCleanup(state);
        } else {
          state = {
            ...state,
            consecutiveCompactFailures: state.consecutiveCompactFailures + 1,
          };
        }

        const afterCanonicalLength = canonicalMessages.length;
        layerExecutions.push({
          layer: "auto_compact",
          beforeTokens: postLightBudget,
          afterTokens: estimateInputTokens({
            systemPrompt: input.systemPrompt,
            messages: apiView,
            tools: input.tools,
            state,
          }),
          reason:
            afterCanonicalLength < beforeCanonicalLength
              ? "Still above error threshold after light layers"
              : "Auto compact attempted but no effective reduction",
        });
      }
    }

    const finalBudgetTokens = estimateInputTokens({
      systemPrompt: input.systemPrompt,
      messages: apiView,
      tools: input.tools,
      state,
    });
    const finalBudget = buildBudgetSnapshot(finalBudgetTokens, this.config);

    const latestBoundaryId = canonicalMessages.find((message) => message.compactBoundary)
      ?.compactBoundary?.boundaryId;
    const nextState: ContextRuntimeState = {
      ...state,
      ...(latestBoundaryId ? { activeBoundaryId: latestBoundaryId } : {}),
      lastProjectedApiViewId: `api_${Date.now()}_${state.roundIndex}_${apiView.length}`,
      lastLayerExecutions: layerExecutions.slice(-30),
      lastBudget: finalBudget,
    };

    return { messages: apiView, canonicalMessages, nextState, budget: finalBudget };
  }

  onModelResponse(input: {
    contextState?: ContextRuntimeState;
    response: ModelResponse;
    estimatedInputTokens: number;
    messageCount?: number;
  }): ContextRuntimeState {
    const state = input.contextState ?? initialContextRuntimeState();
    const usage: TokenUsage | undefined = input.response.usage;
    const extractedSummary =
      input.response.type === "final"
        ? buildSessionSummaryFromOutput(input.response.output)
        : undefined;
    const nextSessionMemory = mergeSessionMemoryState(
      state.sessionMemoryState,
      extractedSummary,
      state.roundIndex + 1,
    );
    return {
      ...state,
      roundIndex: state.roundIndex + 1,
      promptTooLongRetries: 0,
      lastKnownUsage: usage ?? {
        inputTokens: input.estimatedInputTokens,
      },
      ...(input.messageCount !== undefined
        ? { lastUsageAnchorMessageCount: input.messageCount }
        : {}),
      ...(nextSessionMemory ? { sessionMemoryState: nextSessionMemory } : {}),
    };
  }

  onReactiveRecovery(input: {
    contextState?: ContextRuntimeState;
    canonicalMessages: RunMessage[];
    reason: "prompt_too_long" | "media_too_large" | "context_overflow" | "max_output_tokens";
    memory: Record<string, unknown>;
  }): ContextErrorRecoveryResult {
    const state = input.contextState ?? initialContextRuntimeState();
    if (
      state.promptTooLongRetries >= this.config.maxPromptTooLongRetries ||
      state.promptTooLongRetries >= this.config.maxReactiveCompactAttempts
    ) {
      return { recovered: false, canonicalMessages: input.canonicalMessages, nextState: state };
    }

    const recovered = recoverFromContextError(
      {
        canonicalMessages: input.canonicalMessages,
        state,
        reason: input.reason,
      },
      {
        maxCompactRequestRetries: this.config.maxCompactRequestRetries,
        compactRequestMaxInputChars: this.config.compactRequestMaxInputChars,
        historySnipMaxDropRounds: this.config.historySnipMaxDropRounds,
      },
    );

    if (!recovered.recovered) {
      return {
        ...recovered,
        nextState: {
          ...recovered.nextState,
          consecutiveCompactFailures: recovered.nextState.consecutiveCompactFailures + 1,
        },
      };
    }

    const compactBoundary = recovered.canonicalMessages[0]?.compactBoundary;
    let nextState = recovered.nextState;
    if (compactBoundary) {
      nextState = appendCompactBoundary(
        nextState,
        { boundaryId: compactBoundary.boundaryId, strategy: compactBoundary.strategy },
        Math.max(1, input.canonicalMessages.length - recovered.canonicalMessages.length),
      );
      const summaryMessage = recovered.canonicalMessages.find((m) => m.preservedSegmentRef);
      if (summaryMessage?.preservedSegmentRef) {
        nextState = storePreservedSegment(nextState, {
          segmentId: summaryMessage.preservedSegmentRef.segmentId,
          digest: summaryMessage.preservedSegmentRef.digest,
          summary: summaryMessage.content,
          messageIds: input.canonicalMessages
            .slice(
              0,
              Math.max(1, input.canonicalMessages.length - recovered.canonicalMessages.length),
            )
            .map((m) => m.id),
        });
      }
      nextState = runPostCompactCleanup(nextState);
    } else {
      return recovered;
    }

    const hints = buildRehydrationHints({
      memory: input.memory,
      rehydrationTokenBudget: this.config.rehydrationTokenBudget,
      recentFileBudgetTokens: this.config.recentFileBudgetTokens,
      skillsRehydrateBudgetTokens: this.config.skillsRehydrateBudgetTokens,
    });
    const canonicalWithHints = [...recovered.canonicalMessages, ...hints];
    return {
      recovered: true,
      canonicalMessages: canonicalWithHints,
      nextState,
    };
  }

  shouldTripCompactBreaker(state?: ContextRuntimeState): boolean {
    const current = state ?? initialContextRuntimeState();
    return current.consecutiveCompactFailures >= this.config.maxConsecutiveCompactFailures;
  }
}

const buildSessionSummaryFromOutput = (output: string): string | undefined => {
  const text = output.trim();
  if (text.length < 80) return undefined;
  return text.slice(0, 600);
};

const clamp01 = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

const mergeSessionMemoryState = (
  current: ContextRuntimeState["sessionMemoryState"],
  extractedSummary: string | undefined,
  nextRoundIndex: number,
): ContextRuntimeState["sessionMemoryState"] | undefined => {
  if (!current && !extractedSummary) return undefined;
  const base = current ?? {};
  if (!extractedSummary) return base;
  const shouldUpdateCold = !base.coldSummaryText || nextRoundIndex % 6 === 0;
  return {
    ...base,
    lastSummaryAt: new Date().toISOString(),
    summarySourceRound: nextRoundIndex,
    hotSummaryText: extractedSummary,
    ...(shouldUpdateCold
      ? {
          coldSummaryText: mergeColdSummary(base.coldSummaryText, extractedSummary),
          lastColdSummaryAt: new Date().toISOString(),
        }
      : {}),
  };
};

const mergeColdSummary = (current: string | undefined, incoming: string): string => {
  if (!current) return incoming.slice(0, 900);
  const merged = `${current}\n- ${incoming}`;
  return merged.slice(-900);
};

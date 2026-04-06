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
import { resolveRehydrationPlan } from "./rehydration";
import { stripMediaFromMessages } from "./media-strip";
import { applySessionMemoryCompact } from "./session-memory-compact";
import { buildBudgetSnapshot } from "./thresholds";
import { applyToolResultBudget, hydrateToolResultCacheRefs } from "./tool-result-budget";
import {
  appendCompactBoundary,
  recordCompactionDiagnostic,
  storePreservedSegment,
} from "./persistence";
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
  preservedContextAssets: {},
  preservedSegments: {},
  compactBoundaries: [],
  compactionDiagnostics: [],
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
    memory: unknown;
    contextState?: ContextRuntimeState;
    querySource?: string;
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
    const pendingDiagnostics: Array<
      Omit<
        import("./types").ContextCompactionDiagnostic,
        "diagnosticId" | "createdAt" | "rehydratedAssetIds"
      >
    > = [];
    let appliedCompactLayer = false;

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
    const postToolBudgetTokens = estimateInputTokens({
      systemPrompt: input.systemPrompt,
      messages: apiView,
      tools: input.tools,
      state,
    });
    const postToolBudget = buildBudgetSnapshot(postToolBudgetTokens, this.config);
    layerExecutions.push({
      layer: "tool_result_budget",
      beforeTokens: beforeBudgetTokens,
      afterTokens: postToolBudgetTokens,
      reason: "Always enforce tool result soft budget",
    });

    const shouldSuppressHeavyCompaction = isInternalCompactionSource(input.querySource);

    if (!postToolBudget.requiresAutoCompact) {
      const tokenHeadroom = Math.max(
        0,
        postToolBudget.autoCompactThreshold - postToolBudget.estimatedInputTokens,
      );
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

    if (postToolBudget.requiresAutoCompact && !shouldSuppressHeavyCompaction) {
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

      apiView = applyMicrocompact(
        apiView,
        this.config.microcompactMaxToolChars,
        state.roundIndex,
        this.config.microcompactMaxAgeMs,
      );
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
        state = runPostCompactCleanup(state, input.querySource);
        pendingDiagnostics.push({
          strategy: "session_memory",
          source: "prepare",
          reason: "Fast path from session memory",
          ...(input.querySource ? { querySource: input.querySource } : {}),
          beforeTokens: budget.estimatedInputTokens,
          afterTokens: estimateInputTokens({
            systemPrompt: input.systemPrompt,
            messages: apiView,
            tools: input.tools,
            state,
          }),
          compactedMessageCount: sessionCompacted.compactedMessageCount,
          boundaryId: sessionCompacted.boundary.boundaryId,
          ...(sessionCompacted.preservedSegment
            ? { preservedSegmentId: sessionCompacted.preservedSegment.segmentId }
            : {}),
        });
        appliedCompactLayer = true;
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
          state = runPostCompactCleanup(state, input.querySource);
          pendingDiagnostics.push({
            strategy: "auto_compact",
            source: "prepare",
            reason: "Still above error threshold after light layers",
            ...(input.querySource ? { querySource: input.querySource } : {}),
            beforeTokens: postLightBudget,
            afterTokens: estimateInputTokens({
              systemPrompt: input.systemPrompt,
              messages: apiView,
              tools: input.tools,
              state,
            }),
            compactedMessageCount: compacted.compactedMessageCount,
            boundaryId: compacted.boundary.boundaryId,
            ...(compacted.preservedSegment
              ? { preservedSegmentId: compacted.preservedSegment.segmentId }
              : {}),
          });
          appliedCompactLayer = true;
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

    if (appliedCompactLayer) {
      const withRehydration = this.appendRehydrationHints(
        apiView,
        canonicalMessages,
        input.memory,
        state,
        state.roundIndex + 1,
      );
      apiView = withRehydration.apiView;
      canonicalMessages = withRehydration.canonicalMessages;
      for (const diagnostic of pendingDiagnostics) {
        state = recordCompactionDiagnostic(state, {
          ...diagnostic,
          rehydratedAssetIds: withRehydration.rehydratedAssetIds,
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
    };
  }

  onReactiveRecovery(input: {
    contextState?: ContextRuntimeState;
    canonicalMessages: RunMessage[];
    reason: "prompt_too_long" | "media_too_large" | "context_overflow" | "max_output_tokens";
    memory: unknown;
    querySource?: string;
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
    let summaryMessage:
      | (RunMessage & {
          preservedSegmentRef?: {
            segmentId: string;
            digest: string;
          };
        })
      | undefined;
    if (compactBoundary) {
      nextState = appendCompactBoundary(
        nextState,
        { boundaryId: compactBoundary.boundaryId, strategy: compactBoundary.strategy },
        Math.max(1, input.canonicalMessages.length - recovered.canonicalMessages.length),
      );
      summaryMessage =
        recovered.canonicalMessages.find((m) => m.id.startsWith("summary_")) ??
        recovered.canonicalMessages.find((m) => m.preservedSegmentRef && !m.compactBoundary);
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
      nextState = runPostCompactCleanup(nextState, input.querySource);
    } else {
      nextState = {
        ...nextState,
        consecutiveCompactFailures: 0,
      };
    }

    const withRehydration = this.appendRehydrationHints(
      recovered.canonicalMessages.map(
        ({ messageId: _messageId, source: _source, ...message }) => message,
      ),
      recovered.canonicalMessages,
      input.memory,
      nextState,
      nextState.roundIndex + 1,
    );
    if (compactBoundary) {
      nextState = recordCompactionDiagnostic(nextState, {
        strategy: "reactive_compact",
        source: "recovery",
        reason: input.reason,
        ...(input.querySource ? { querySource: input.querySource } : {}),
        beforeTokens: 0,
        afterTokens: 0,
        compactedMessageCount: Math.max(
          1,
          input.canonicalMessages.length - recovered.canonicalMessages.length,
        ),
        boundaryId: compactBoundary.boundaryId,
        ...(summaryMessage?.preservedSegmentRef
          ? { preservedSegmentId: summaryMessage.preservedSegmentRef.segmentId }
          : {}),
        rehydratedAssetIds: withRehydration.rehydratedAssetIds,
      });
    }
    return {
      recovered: true,
      canonicalMessages: withRehydration.canonicalMessages,
      nextState,
    };
  }

  compact(input: {
    systemPrompt: string;
    tools: ToolDefinition[];
    apiView: AgentMessage[];
    canonicalMessages: RunMessage[];
    memory: unknown;
    contextState?: ContextRuntimeState;
    customInstructions?: string;
  }): ContextPrepareResult {
    let state = input.contextState ?? initialContextRuntimeState();
    const projected = projectApiView(input.apiView, input.canonicalMessages, state);
    let apiView = hydrateToolResultCacheRefs(projected.apiView, state);
    let canonicalMessages = projected.canonical;
    const layerExecutions = [...state.lastLayerExecutions];
    const pendingDiagnostics: Array<
      Omit<
        import("./types").ContextCompactionDiagnostic,
        "diagnosticId" | "createdAt" | "rehydratedAssetIds"
      >
    > = [];

    apiView = stripMediaFromMessages(apiView);
    const toolBudgeted = applyToolResultBudget(apiView, state, this.config);
    apiView = toolBudgeted.messages;
    state = toolBudgeted.nextState;
    apiView = applyMicrocompact(
      apiView,
      this.config.microcompactMaxToolChars,
      state.roundIndex,
      this.config.microcompactMaxAgeMs,
    );
    layerExecutions.push({
      layer: "microcompact",
      beforeTokens: 0,
      afterTokens: 0,
      reason: "Manual compact pre-pass on cold tool outputs",
    });

    const sessionCompacted =
      input.customInstructions === undefined || input.customInstructions.trim().length === 0
        ? applySessionMemoryCompact(apiView, canonicalMessages, input.memory, state)
        : {
            messages: apiView,
            canonicalMessages,
            nextState: state,
            compactedMessageCount: 0,
          };

    if (sessionCompacted.compactedMessageCount > 0 && sessionCompacted.boundary) {
      apiView = sessionCompacted.messages;
      canonicalMessages = sessionCompacted.canonicalMessages;
      state = appendCompactBoundary(
        sessionCompacted.nextState,
        sessionCompacted.boundary,
        sessionCompacted.compactedMessageCount,
      );
      if (sessionCompacted.preservedSegment) {
        state = storePreservedSegment(state, sessionCompacted.preservedSegment);
      }
      state = runPostCompactCleanup(state);
      pendingDiagnostics.push({
        strategy: "session_memory",
        source: "manual",
        reason: "Manual compact used session memory fast path",
        beforeTokens: 0,
        afterTokens: 0,
        compactedMessageCount: sessionCompacted.compactedMessageCount,
        boundaryId: sessionCompacted.boundary.boundaryId,
        ...(sessionCompacted.preservedSegment
          ? { preservedSegmentId: sessionCompacted.preservedSegment.segmentId }
          : {}),
      });
      layerExecutions.push({
        layer: "session_memory_compact",
        beforeTokens: 0,
        afterTokens: 0,
        reason: "Manual compact used session memory fast path",
      });
    } else {
      const compacted = applyAutoCompact(apiView, canonicalMessages, "manual_compact", {
        maxCompactRequestRetries: this.config.maxCompactRequestRetries,
        compactRequestMaxInputChars: this.config.compactRequestMaxInputChars,
        historySnipMaxDropRounds: this.config.historySnipMaxDropRounds,
        ...(input.customInstructions ? { customInstructions: input.customInstructions } : {}),
      });
      apiView = compacted.apiView;
      canonicalMessages = compacted.canonicalMessages;
      if (compacted.compactedMessageCount > 0 && compacted.boundary) {
        state = appendCompactBoundary(state, compacted.boundary, compacted.compactedMessageCount);
        if (compacted.preservedSegment) {
          state = storePreservedSegment(state, compacted.preservedSegment);
        }
        state = runPostCompactCleanup(state);
        pendingDiagnostics.push({
          strategy: "manual_compact",
          source: "manual",
          reason: "Manual compact forced summary boundary",
          beforeTokens: 0,
          afterTokens: 0,
          compactedMessageCount: compacted.compactedMessageCount,
          boundaryId: compacted.boundary.boundaryId,
          ...(compacted.preservedSegment
            ? { preservedSegmentId: compacted.preservedSegment.segmentId }
            : {}),
        });
      }
      layerExecutions.push({
        layer: "auto_compact",
        beforeTokens: 0,
        afterTokens: 0,
        reason: "Manual compact forced summary boundary",
      });
    }

    const withRehydration = this.appendRehydrationHints(
      apiView,
      canonicalMessages,
      input.memory,
      state,
      state.roundIndex + 1,
    );
    apiView = withRehydration.apiView;
    canonicalMessages = withRehydration.canonicalMessages;
    for (const diagnostic of pendingDiagnostics) {
      state = recordCompactionDiagnostic(state, {
        ...diagnostic,
        rehydratedAssetIds: withRehydration.rehydratedAssetIds,
      });
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

  shouldTripCompactBreaker(state?: ContextRuntimeState): boolean {
    const current = state ?? initialContextRuntimeState();
    return current.consecutiveCompactFailures >= this.config.maxConsecutiveCompactFailures;
  }

  private appendRehydrationHints(
    apiView: AgentMessage[],
    canonicalMessages: RunMessage[],
    memory: unknown,
    state: ContextRuntimeState,
    roundIndex: number,
  ): {
    apiView: AgentMessage[];
    canonicalMessages: RunMessage[];
    rehydratedAssetIds: string[];
  } {
    const rehydration = resolveRehydrationPlan({
      memory,
      assets: Object.values(state.preservedContextAssets ?? {}),
      rehydrationTokenBudget: this.config.rehydrationTokenBudget,
      recentFileBudgetTokens: this.config.recentFileBudgetTokens,
      skillsRehydrateBudgetTokens: this.config.skillsRehydrateBudgetTokens,
      roundIndex,
    });
    const hints = rehydration.messages;
    if (hints.length === 0) {
      return { apiView, canonicalMessages, rehydratedAssetIds: [] };
    }

    const canonicalWithoutPreviousHints = canonicalMessages.filter(
      (message) => !message.id.startsWith("rehydration_"),
    );
    const canonicalWithHints = [...canonicalWithoutPreviousHints, ...hints];
    const apiWithoutPreviousHints = apiView.filter(
      (message) => !message.id.startsWith("rehydration_"),
    );
    const apiWithHints = [
      ...apiWithoutPreviousHints,
      ...hints.map(({ messageId: _messageId, source: _source, ...message }) => message),
    ];
    return {
      apiView: apiWithHints,
      canonicalMessages: canonicalWithHints,
      rehydratedAssetIds: rehydration.assetIds,
    };
  }
}

const clamp01 = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

const isInternalCompactionSource = (querySource: string | undefined): boolean => {
  if (!querySource) return false;
  return (
    querySource === "session_memory" || querySource === "compact" || querySource === "subagent"
  );
};

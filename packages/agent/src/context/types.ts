import type { AgentMessage, TokenUsage, ToolDefinition } from "@renx/model";

import type { RunMessage } from "../message/types";

export type ContextCompressionLayer =
  | "media_stripping"
  | "tool_result_budget"
  | "history_snip"
  | "microcompact"
  | "context_collapse"
  | "session_memory_compact"
  | "auto_compact"
  | "reactive_compact";

export interface ContextThresholdConfig {
  warningRatio?: number;
  autoCompactRatio?: number;
  errorRatio?: number;
  blockingRatio?: number;
  warningBufferTokens?: number;
  autoCompactBufferTokens?: number;
  errorBufferTokens?: number;
  blockingHeadroomTokens?: number;
}

export interface ContextManagerConfig {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxPromptTooLongRetries: number;
  maxReactiveCompactAttempts: number;
  maxCompactRequestRetries: number;
  compactRequestMaxInputChars: number;
  maxConsecutiveCompactFailures: number;
  toolResultSoftCharLimit: number;
  historySnipKeepRounds: number;
  historySnipMaxDropRounds: number;
  microcompactMaxToolChars: number;
  collapseRestoreMaxMessages: number;
  collapseRestoreTokenHeadroomRatio: number;
  rehydrationTokenBudget: number;
  recentFileBudgetTokens: number;
  skillsRehydrateBudgetTokens: number;
  thresholds: ContextThresholdConfig;
}

export interface ContextBudgetSnapshot {
  estimatedInputTokens: number;
  warningThreshold: number;
  autoCompactThreshold: number;
  errorThreshold: number;
  blockingThreshold: number;
  inWarning: boolean;
  requiresAutoCompact: boolean;
  shouldBlock: boolean;
}

export interface ContextLayerExecution {
  layer: ContextCompressionLayer;
  beforeTokens: number;
  afterTokens: number;
  reason: string;
}

export interface CompactBoundaryRecord {
  boundaryId: string;
  parentBoundaryId?: string;
  strategy: "session_memory" | "auto_compact" | "reactive_compact";
  createdAt: string;
  compactedMessageCount: number;
}

export interface ContextRuntimeState {
  roundIndex: number;
  activeBoundaryId?: string;
  lastProjectedApiViewId?: string;
  lastKnownUsage?: TokenUsage;
  lastUsageAnchorMessageCount?: number;
  lastSummaryResponseId?: string;
  forkedCachePrefix?: string;
  lastBudget?: ContextBudgetSnapshot;
  lastLayerExecutions: ContextLayerExecution[];
  consecutiveCompactFailures: number;
  promptTooLongRetries: number;
  toolResultCache: Record<string, string>;
  preservedSegments: Record<
    string,
    {
      digest: string;
      summary: string;
      messageIds: string[];
      createdAt: string;
    }
  >;
  compactBoundaries: CompactBoundaryRecord[];
  contextCollapseState?: {
    collapsedMessageIds: string[];
    lastCollapsedAt: string;
    lastRestoredAt?: string;
    segments: Record<
      string,
      {
        createdAt: string;
        messageIds: string[];
        messages: AgentMessage[];
      }
    >;
  };
  toolResultStorageState?: {
    cachedRefs: string[];
    evictedRefs: string[];
  };
  sessionMemoryState?: {
    lastSummaryAt?: string;
    summarySourceRound?: number;
    hotSummaryText?: string;
    coldSummaryText?: string;
    lastColdSummaryAt?: string;
  };
}

export interface ContextPrepareInput {
  messages: AgentMessage[];
  canonicalMessages: RunMessage[];
  tools: ToolDefinition[];
  state: ContextRuntimeState;
}

export interface ContextPrepareResult {
  messages: AgentMessage[];
  canonicalMessages?: RunMessage[];
  nextState: ContextRuntimeState;
  budget: ContextBudgetSnapshot;
}

export interface ContextUpdateInput {
  state: ContextRuntimeState;
  usage?: TokenUsage;
  estimatedInputTokens: number;
}

export interface ContextErrorRecoveryInput {
  canonicalMessages: RunMessage[];
  state: ContextRuntimeState;
  reason: "prompt_too_long" | "media_too_large" | "context_overflow" | "max_output_tokens";
}

export interface ContextErrorRecoveryResult {
  recovered: boolean;
  canonicalMessages: RunMessage[];
  nextState: ContextRuntimeState;
}

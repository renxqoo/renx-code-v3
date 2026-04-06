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
  microcompactMaxAgeMs?: number;
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
  strategy: "session_memory" | "auto_compact" | "reactive_compact" | "manual_compact";
  createdAt: string;
  compactedMessageCount: number;
}

export type PreservedContextKind =
  | "recent_files"
  | "plan"
  | "skills"
  | "rules"
  | "hooks"
  | "mcp"
  | "custom";

export interface PreservedContextAsset {
  id: string;
  kind: PreservedContextKind;
  content: string;
  title?: string;
  priority?: number;
  budgetTokens?: number;
  allowTruncation?: boolean;
  updatedAt: string;
  scope?: "user" | "project" | "local";
  metadata?: Record<string, unknown>;
}

export interface EffectiveRequestSnapshot {
  capturedAt: string;
  systemPrompt: string;
  messages: AgentMessage[];
  toolNames: string[];
  contextMetadata?: Record<string, unknown>;
}

export interface ContextCompactionDiagnostic {
  diagnosticId: string;
  strategy: CompactBoundaryRecord["strategy"];
  source: "prepare" | "manual" | "recovery";
  reason: string;
  createdAt: string;
  querySource?: string;
  beforeTokens: number;
  afterTokens: number;
  compactedMessageCount: number;
  boundaryId?: string;
  preservedSegmentId?: string;
  rehydratedAssetIds: string[];
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
  preservedContextAssets?: Record<string, PreservedContextAsset>;
  preservedSegments: Record<
    string,
    {
      digest: string;
      summary: string;
      messageIds: string[];
      messages?: RunMessage[];
      createdAt: string;
    }
  >;
  compactBoundaries: CompactBoundaryRecord[];
  compactionDiagnostics?: ContextCompactionDiagnostic[];
  pendingPostCompactLifecycle?: {
    diagnosticId: string;
    strategy: CompactBoundaryRecord["strategy"];
    source: ContextCompactionDiagnostic["source"];
    createdAt: string;
    boundaryId?: string;
    startedAt?: string;
  };
  lastEffectiveRequestSnapshot?: EffectiveRequestSnapshot;
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
    template?: string;
    notes?: string;
    initialized?: boolean;
    tokensAtLastExtraction?: number;
    summarySourceRound?: number;
    lastExtractionMessageId?: string;
    lastSummarizedMessageId?: string;
    lastExtractedAt?: string;
    extractionStartedAt?: string;
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

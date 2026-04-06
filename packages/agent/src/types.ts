import type { AgentMessage, Metadata, ModelResponse, ToolCall } from "@renx/model";

// Re-export commonly used types from @renx/model
export type { Metadata } from "@renx/model";

import type { AgentError } from "./errors";
import type { AgentTool, ToolResult } from "./tool/types";
import type { RunMessage } from "./message/types";
import type {
  ContextCompactionDiagnostic,
  ContextRuntimeState,
  EffectiveRequestSnapshot,
} from "./context/types";
import type { MemorySnapshot, MemorySubsystem } from "./memory";
import type { SkillsSubsystem } from "./skills/types";

// Re-export tool types needed by other modules
export type {
  AgentTool,
  ToolResult,
  ToolContext,
  ToolExecutionResult,
  ToolRegistry,
  BackendResolver,
  ExecutionBackend,
} from "./tool/types";

// --- Status ---

export type AgentStatus = "running" | "completed" | "failed" | "interrupted" | "waiting_approval";

// --- State ---

export interface AgentState {
  runId: string;
  threadId?: string;
  messages: RunMessage[];
  scratchpad: Metadata;
  memory: MemorySnapshot;
  stepCount: number;
  status: AgentStatus;
  lastModelResponse?: ModelResponse;
  lastToolCall?: ToolCall;
  lastToolResult?: ToolResult;
  context?: ContextRuntimeState;
  error?: AgentError;
}

// --- State Patch ---

export interface AgentStatePatch {
  appendMessages?: RunMessage[];
  replaceMessages?: RunMessage[];
  setScratchpad?: Metadata;
  mergeMemory?: MemorySnapshot;
  setContext?: ContextRuntimeState;
  setStatus?: AgentStatus;
  setError?: AgentError;
}

// --- Identity ---

export interface AgentIdentity {
  userId: string;
  tenantId: string;
  roles: string[];
  sessionId?: string;
}

// --- Input ---

export interface AgentInput {
  messages?: RunMessage[];
  context?: unknown;
  metadata?: Metadata;
  signal?: AbortSignal;
}

// --- Service Interfaces ---

export interface TimelineStore {
  load(runId: string): Promise<TimelineNode | null>;
  loadNode(runId: string, nodeId: string): Promise<TimelineNode | null>;
  listNodes(runId: string): Promise<TimelineNode[]>;
  save(node: TimelineNode, expectedVersion?: number): Promise<number>;
  delete?(runId: string): Promise<void>;
}

export interface SessionMemoryRecord {
  template: string;
  notes: string;
  initialized: boolean;
  tokensAtLastExtraction: number;
  lastExtractionMessageId?: string;
  lastSummarizedMessageId?: string;
  lastExtractedAt?: string;
  extractionStartedAt?: string;
  summarySourceRound?: number;
}

export interface SessionMemoryConfig {
  minimumTokensToInit: number;
  minimumTokensBetweenUpdates: number;
  toolCallsBetweenUpdates: number;
  extractMaxTokens: number;
  extractionWaitTimeoutMs: number;
  extractionStaleAfterMs: number;
  extractionPollIntervalMs: number;
  maxUpdateMessages: number;
  maxMessageChars: number;
}

export interface SessionMemoryStore {
  load(runId: string): Promise<SessionMemoryRecord | null> | SessionMemoryRecord | null;
  save(runId: string, record: SessionMemoryRecord): Promise<void> | void;
}

export type SessionMemoryMode = "sync" | "deferred";

export interface SessionMemoryExtractionInput {
  runId: string;
  notesPath: string;
  record: SessionMemoryRecord;
  conversation: RunMessage[];
  prompt: string;
  config: SessionMemoryConfig;
  signal?: AbortSignal;
}

export interface SessionMemoryExtractionResult {
  notes: string;
}

export interface SessionMemoryExtractor {
  extract(
    input: SessionMemoryExtractionInput,
  ): Promise<SessionMemoryExtractionResult> | SessionMemoryExtractionResult;
}

export interface SessionMemoryEvent {
  type:
    | "session_memory_initialized"
    | "session_memory_extraction_started"
    | "session_memory_extraction_completed"
    | "session_memory_extraction_failed"
    | "session_memory_extraction_skipped";
  runId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface SessionMemoryHooks {
  onEvent(event: SessionMemoryEvent): Promise<void> | void;
}

export interface SessionMemoryPromptInput {
  notesPath: string;
  currentNotes: string;
  conversation: RunMessage[];
  record: SessionMemoryRecord;
  config: SessionMemoryConfig;
}

export interface SessionMemorySubsystem {
  store: SessionMemoryStore;
  extractor?: SessionMemoryExtractor;
  config?: Partial<SessionMemoryConfig>;
  mode?: SessionMemoryMode;
  template?: string;
  promptBuilder?: (input: SessionMemoryPromptInput) => string;
  hooks?: SessionMemoryHooks;
}

export interface AgentResumeSnapshot {
  runId: string;
  nodeId: string;
  mode: "head" | "node";
  state: AgentState;
  apiView: AgentMessage[];
  effectiveRequest?: EffectiveRequestSnapshot;
  diagnostics: ContextCompactionDiagnostic[];
  createdAt: string;
}

export interface ContextLifecycleHooks {
  beforeCompact?(event: {
    runId: string;
    source: "prepare" | "manual" | "recovery";
    reason: string;
    querySource?: string;
  }): Promise<void> | void;
  afterCompact?(event: {
    runId: string;
    diagnostic: ContextCompactionDiagnostic;
  }): Promise<void> | void;
  beforeResume?(event: {
    runId: string;
    nodeId: string;
    mode: "head" | "node";
  }): Promise<void> | void;
  afterResume?(snapshot: AgentResumeSnapshot): Promise<void> | void;
  onPostCompactTurnStart?(event: {
    runId: string;
    diagnostic: ContextCompactionDiagnostic;
  }): Promise<void> | void;
  onPostCompactTurnComplete?(event: {
    runId: string;
    diagnostic: ContextCompactionDiagnostic;
  }): Promise<void> | void;
}

export type ResumeAtMode = "fork" | "fast_forward" | "read_only_preview";

export interface ResumeAtOptions {
  mode?: ResumeAtMode;
  allowIrreversibleTools?: boolean;
}

export interface AuditLogger {
  log(event: AuditEvent): Promise<void> | void;
}

/** Generic store interface for any persisted data. */
export interface Store<T = Metadata> {
  load(ctx: AgentRunContext): Promise<T> | T;
  save?(ctx: AgentRunContext, data: T): Promise<void> | void;
}

export interface PolicyEngine {
  filterTools(ctx: AgentRunContext, tools: AgentTool[]): Promise<AgentTool[]> | AgentTool[];
  canUseTool(ctx: AgentRunContext, tool: AgentTool, input: unknown): Promise<boolean> | boolean;
  redactOutput?(ctx: AgentRunContext, output: string): Promise<string> | string;
}

// --- Timeline ---

export interface TimelineNode {
  nodeId: string;
  parentNodeId?: string;
  runId: string;
  state: AgentState;
  version: number;
  metadata?: Metadata;
  createdAt: string;
  updatedAt: string;
}

// --- Audit ---

export type AuditEventType =
  | "run_started"
  | "context_budget_measured"
  | "context_warning_entered"
  | "context_auto_compact_triggered"
  | "context_blocking_triggered"
  | "context_layer_applied"
  | "context_recovery_retry"
  | "context_usage_snapshot_updated"
  | "model_called"
  | "model_returned"
  | "tool_called"
  | "tool_succeeded"
  | "tool_failed"
  | "approval_requested"
  | "approval_resolved"
  | "run_completed"
  | "run_failed";

export interface AuditEvent {
  id: string;
  runId: string;
  type: AuditEventType;
  timestamp: string;
  actor?: string;
  payload: Record<string, unknown>;
}

// --- Approval ---

export interface ApprovalTicket {
  id: string;
  runId: string;
  toolName: string;
  input: unknown;
  requestedAt: string;
  reason?: string;
  expiresAt?: string;
  metadata?: Metadata;
}

export type ApprovalDecisionStatus = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalDecision {
  ticketId: string;
  status: ApprovalDecisionStatus;
  reviewerId?: string;
  comment?: string;
  decidedAt?: string;
}

export interface ApprovalEvaluation {
  required: boolean;
  reason?: string;
  expiresAt?: string;
  metadata?: Metadata;
}

export interface ApprovalEngine {
  evaluate(
    ctx: AgentRunContext,
    tool: AgentTool,
    input: unknown,
  ): Promise<ApprovalEvaluation> | ApprovalEvaluation;
  request(ctx: AgentRunContext, ticket: ApprovalTicket): Promise<void> | void;
  getDecision(
    ctx: AgentRunContext,
    ticketId: string,
  ): Promise<ApprovalDecision | null> | ApprovalDecision | null;
}

// --- Recovery ---

export interface RecoveryConfig {
  maxOutputTokensRecoveryLimit?: number;
  maxPromptTooLongRetries?: number;
}

// --- Run Context ---

export interface AgentServices {
  timeline?: TimelineStore;
  audit?: AuditLogger;
  approvalEngine?: ApprovalEngine;
  recovery?: RecoveryConfig;
  memory?: MemorySubsystem;
  sessionMemory?: SessionMemorySubsystem;
  skills?: SkillsSubsystem;
}

export interface AgentRunContext {
  input: AgentInput;
  identity: AgentIdentity;
  state: AgentState;
  services: AgentServices;
  metadata: Metadata;
}

// --- Result ---

export interface AgentResult {
  runId: string;
  status: AgentStatus;
  output?: string;
  error?: AgentError;
  state: AgentState;
  messages?: RunMessage[];
  structuredResponse?: unknown;
}

export interface AgentCompactOptions {
  customInstructions?: string;
}

export interface AgentCompactResult {
  runId: string;
  compacted: boolean;
  state: AgentState;
}

// --- Streaming (type only, deferred impl) ---

export type AgentStreamEvent =
  | { type: "run_started"; runId: string }
  | { type: "model_started" }
  | { type: "assistant_delta"; text: string }
  | { type: "tool_call_delta"; partial: unknown }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; result: ToolResult }
  | { type: "run_completed"; output: string }
  | { type: "run_failed"; error: AgentError };

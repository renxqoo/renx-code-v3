import type { Metadata, ModelResponse, ToolCall } from "@renx/model";

// Re-export commonly used types from @renx/model
export type { Metadata } from "@renx/model";

import type { AgentError } from "./errors";
import type { AgentTool, ToolResult } from "./tool/types";
import type { RunMessage } from "./message/types";

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
  memory: Metadata;
  stepCount: number;
  status: AgentStatus;
  lastModelResponse?: ModelResponse;
  lastToolCall?: ToolCall;
  lastToolResult?: ToolResult;
  error?: AgentError;
}

// --- State Patch ---

export interface AgentStatePatch {
  appendMessages?: RunMessage[];
  setScratchpad?: Metadata;
  mergeMemory?: Metadata;
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
  inputText?: string;
  metadata?: Metadata;
  signal?: AbortSignal;
}

// --- Service Interfaces ---

export interface CheckpointStore {
  load(runId: string): Promise<CheckpointRecord | null>;
  save(record: CheckpointRecord): Promise<void>;
  delete?(runId: string): Promise<void>;
}

export interface AuditLogger {
  log(event: AuditEvent): Promise<void> | void;
}

export interface ApprovalService {
  create(request: ApprovalRequest): Promise<void>;
  get(requestId: string): Promise<ApprovalDecision | null>;
}

/** Generic store interface for any persisted data. */
export interface Store<T = Metadata> {
  load(ctx: AgentRunContext): Promise<T> | T;
  save?(ctx: AgentRunContext, data: T): Promise<void> | void;
}

/** Backward-compatible alias. */
export type MemoryStore = Store<Metadata>;

export interface PolicyEngine {
  filterTools(ctx: AgentRunContext, tools: AgentTool[]): Promise<AgentTool[]> | AgentTool[];
  canUseTool(ctx: AgentRunContext, tool: AgentTool, input: unknown): Promise<boolean> | boolean;
  needApproval?(ctx: AgentRunContext, tool: AgentTool, input: unknown): Promise<boolean> | boolean;
  redactOutput?(ctx: AgentRunContext, output: string): Promise<string> | string;
}

// --- Checkpoint ---

export interface CheckpointRecord {
  runId: string;
  state: AgentState;
  metadata?: Metadata;
  createdAt: string;
  updatedAt: string;
}

// --- Audit ---

export type AuditEventType =
  | "run_started"
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

export interface ApprovalRequest {
  id: string;
  runId: string;
  toolName: string;
  input: unknown;
  reason: string;
  createdAt: string;
}

export interface ApprovalDecision {
  requestId: string;
  approved: boolean;
  reviewerId: string;
  comment?: string;
  decidedAt: string;
}

// --- Recovery ---

export interface RecoveryConfig {
  maxOutputTokensRecoveryLimit?: number;
  maxPromptTooLongRetries?: number;
}

// --- Run Context ---

export interface AgentServices {
  checkpoint?: CheckpointStore;
  audit?: AuditLogger;
  approval?: ApprovalService;
  recovery?: RecoveryConfig;
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
}

// --- Streaming (type only, deferred impl) ---

export type AgentStreamEvent =
  | { type: "run_started"; runId: string }
  | { type: "model_started" }
  | { type: "assistant_delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; result: ToolResult }
  | { type: "approval_required"; requestId: string }
  | { type: "run_completed"; output: string }
  | { type: "run_failed"; error: AgentError };

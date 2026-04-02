// @renx/agent — Enterprise Agent SDK

// --- Errors ---
export { AgentError } from "./errors";
export type { AgentErrorCode, AgentErrorInit } from "./errors";

// --- Core Types ---
export type {
  Metadata,
  AgentStatus,
  AgentState,
  AgentStatePatch,
  AgentIdentity,
  AgentInput,
  AgentServices,
  AgentRunContext,
  AgentResult,
  AgentStreamEvent,
  PolicyEngine,
  AuditEventType,
  AuditEvent,
  AuditLogger,
  CheckpointRecord,
  CheckpointStore,
  ApprovalRequest,
  ApprovalDecision,
  ApprovalService,
  Store,
  RecoveryConfig,
} from "./types";

// --- Helpers ---
export { generateId, isTerminalStatus, shouldPause } from "./helpers";

// --- State ---
export { applyStatePatch } from "./state";

// --- Message Management ---
export type {
  MessageValidationIssue,
  MessageValidationResult,
  PatchToolPairsResult,
  MessageStatePatch,
  MessageRenderer,
  MessageSource,
  RunMessage,
} from "./message/types";

export { applyMessagePatch, appendMessages, replaceMessages } from "./message/reducer";
export { validateMessageSequence } from "./message/validator";
export { patchToolPairs } from "./message/patch-tool-pairs";
export { DefaultMessageManager } from "./message/manager";
export type { MessageManager } from "./message/manager";

// --- Tool System ---
export type {
  AgentTool,
  ToolResult,
  ToolContext,
  ToolExecutionResult,
  ToolRegistry,
  BackendResolver,
  ExecutionBackend,
  BackendCapabilities,
  ExecOptions,
  ExecResult,
  FileInfo,
} from "./tool/types";

export { InMemoryToolRegistry } from "./tool/registry";
export { ToolExecutor } from "./tool/executor";
export type { ToolExecutorRunResult, BatchToolResult } from "./tool/executor";
export { validateToolInput } from "./tool/input-validation";
export { LocalBackend } from "./tool/local-backend";
export { DefaultBackendResolver } from "./tool/default-backend-resolver";

// --- Middleware ---
export type { AgentMiddleware, MiddlewareDecision } from "./middleware/types";
export type { AggregatedDecision } from "./middleware/pipeline";
export { MiddlewarePipeline } from "./middleware/pipeline";
export { AgentMemoryMiddleware } from "./middleware/agent-memory";
export type { AgentMemoryOptions } from "./middleware/agent-memory";

// --- Policy ---
export { AllowAllPolicy } from "./policy";

// --- Checkpoint ---
export { InMemoryCheckpointStore } from "./checkpoint";

// --- Audit ---
export { ConsoleAuditLogger } from "./audit";

// --- Runtime ---
export { AgentRuntime } from "./runtime";
export type { RuntimeConfig } from "./runtime";

// --- Context Window Management ---
export { ContextOrchestrator, initialContextRuntimeState } from "./context";
export type {
  ContextCompressionLayer,
  ContextManagerConfig,
  ContextThresholdConfig,
  ContextBudgetSnapshot,
  ContextLayerExecution,
  ContextRuntimeState,
  CompactBoundaryRecord,
} from "./context/types";

// --- Base Class ---
export { EnterpriseAgentBase } from "./base";

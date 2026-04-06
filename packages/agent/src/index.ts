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
  AgentCompactOptions,
  AgentCompactResult,
  AgentStreamEvent,
  PolicyEngine,
  AuditEventType,
  AuditEvent,
  AuditLogger,
  TimelineNode,
  TimelineStore,
  ResumeAtMode,
  ResumeAtOptions,
  ApprovalTicket,
  ApprovalDecision,
  ApprovalDecisionStatus,
  ApprovalEvaluation,
  ApprovalEngine,
  AgentResumeSnapshot,
  ContextLifecycleHooks,
  Store,
  RecoveryConfig,
  SessionMemoryConfig,
  SessionMemoryEvent,
  SessionMemoryExtractionInput,
  SessionMemoryExtractionResult,
  SessionMemoryExtractor,
  SessionMemoryHooks,
  SessionMemoryMode,
  SessionMemoryPromptInput,
  SessionMemoryRecord,
  SessionMemoryStore,
  SessionMemorySubsystem,
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
  BackendSession,
  ExecOptions,
  ExecResult,
  FileInfo,
  CreateSessionOptions,
} from "./tool/types";

export { InMemoryToolRegistry } from "./tool/registry";
export {
  createToolCapabilityProfile,
  getToolRiskLevel,
  hasToolCapabilityTag,
} from "./tool/capability";
export type {
  ToolCapabilityProfile,
  ToolRiskLevel,
  ToolSandboxExpectation,
} from "./tool/capability";
export { ToolExecutor } from "./tool/executor";
export type { ToolExecutorRunResult, BatchToolResult } from "./tool/executor";
export { validateToolInput } from "./tool/input-validation";
export { LocalBackend } from "./tool/local-backend";
export { execWindowsPreferPowerShell, type WinShellExecFileOptions } from "./tool/win-shell-exec";
export { DefaultBackendResolver } from "./tool/default-backend-resolver";

// --- Approval Governance ---
export { InMemoryApprovalDecisionStore, RuleBasedApprovalEngine } from "./approval/rule-based";
export type { ApprovalApproverScope, ApprovalRule } from "./approval/rule-based";

// --- Middleware ---
export type { AgentMiddleware, MiddlewareDecision } from "./middleware/types";
export type { AggregatedDecision } from "./middleware/pipeline";
export { MiddlewarePipeline } from "./middleware/pipeline";
export { AgentMemoryMiddleware } from "./middleware/agent-memory";
export type { AgentMemoryOptions } from "./middleware/agent-memory";

// --- Policy ---
export { AllowAllPolicy, ToolDenyListPolicy } from "./policy";

// --- Timeline ---
export {
  FileTimelineStore,
  InMemoryTimelineStore,
  TimelineVersionConflictError,
  TimelineManager,
} from "./timeline";

// --- Audit ---
export { ConsoleAuditLogger } from "./audit";

// --- Runtime ---
export { AgentRuntime } from "./runtime";
export type { RuntimeConfig } from "./runtime";

// --- Deep Agent ---
export { createDeepAgent } from "./deep-agent";
export type {
  CreateDeepAgentOptions,
  DeepAgentBackend,
  DeepAgentBackendFactory,
  DeepAgentBackendIntegration,
  DeepAgentHandle,
  DeepAgentInvocationOptions,
  DeepAgentInterruptConfig,
  DeepAgentInterruptOn,
  DeepAgentResponseFormat,
  DeepAgentCompiledSubagent,
  DeepAgentInlineSubagent,
  DeepAgentSubagent,
} from "./deep-agent";

// --- Collaboration ---
export { InMemoryBlackboardStore } from "./collaboration/blackboard";
export type { BlackboardEntry, BlackboardScope, BlackboardStore } from "./collaboration/blackboard";
export { CollaborationService, createCollaborationSnapshot } from "./collaboration/service";
export type {
  CollaborationHandoff,
  CollaborationNodeStatus,
  CollaborationSnapshot,
  CollaborationTaskNode,
  SharedMemoryEntry,
} from "./collaboration/service";

// --- Jobs / Checkpoints ---
export { InMemoryJobStore, JobScheduler } from "./jobs/scheduler";
export type { JobRecord, JobStatus, JobStore } from "./jobs/scheduler";
export { DurableCheckpointService, InMemoryCheckpointStore } from "./checkpoint/service";
export type { CheckpointStore, DurableCheckpoint } from "./checkpoint/service";

// --- Memory ---
export {
  createMemorySnapshot,
  mergeMemorySnapshot,
  DEFAULT_MEMORY_AUTOMATION_CONFIG,
  DEFAULT_MEMORY_GOVERNANCE_CONFIG,
  DEFAULT_MEMORY_POLICY,
  applyMemoryGovernance,
  applyMemoryPolicy,
  applyMemoryTenantPolicy,
  extractScopedMemorySnapshot,
  MEMORY_TAXONOMY_TYPES,
  buildMemoryTaxonomyPrompt,
  checkSharedMemorySnapshotForSecrets,
  createMemoryTeamSyncState,
  parseMemoryTaxonomyType,
  decodeRemoteMemoryEntryKey,
  InMemoryMemoryRemoteTransport,
  inspectMemoryHealth,
  MemoryCommandService,
  MemoryTeamSyncService,
  recallMemoryEntries,
  scanMemorySecrets,
  InMemoryMemoryStore,
  FileMemoryStore,
  InMemoryScopedMemoryStore,
  FileScopedMemoryStore,
  InMemoryMemorySyncStateStore,
  FileMemorySyncStateStore,
  MemorySnapshotSyncService,
  MemoryWritePipeline,
  MemoryService,
} from "./memory";
export type {
  MemoryAutomationConfig,
  MemoryAutomationState,
  MemoryConfig,
  MemoryEvent,
  MemoryExtractor,
  MemoryExtractionInput,
  MemoryExtractionResult,
  MemoryGovernanceConfig,
  MemoryHooks,
  MemoryHealthReport,
  MemoryHealthWarning,
  InspectMemoryHealthOptions,
  MemoryNamedContentEntry,
  MemoryPolicy,
  MemoryRecallInput,
  MemoryRecentFileEntry,
  MemoryRemoteEntry,
  MemoryRemotePullResult,
  MemoryRemotePushResult,
  MemoryRemoteTransport,
  MemorySecretMatch,
  ResolvedMemorySnapshot,
  MemoryScope,
  MemoryScopeContext,
  MemoryScopeResolution,
  MemorySemanticEntry,
  MemorySnapshot,
  MemoryStore,
  MemoryTeamSyncPullResult,
  MemoryTeamSyncPushResult,
  MemoryTeamSyncServiceOptions,
  MemoryTeamSyncState,
  MemoryTenantPolicy,
  MemoryTaxonomyType,
  MemorySyncState,
  MemorySyncStateStore,
  MemorySubsystem,
  ScopedMemoryStore,
  SharedMemorySecretIssue,
  SharedMemorySecretReport,
} from "./memory";

// --- Context Window Management ---
export { ContextOrchestrator, initialContextRuntimeState } from "./context";
export { ContextSourceTaxonomy } from "./context/source-taxonomy";
export type { ClassifiedContextSource, ContextSourceDescriptor } from "./context/source-taxonomy";
export {
  DEFAULT_SESSION_MEMORY_CONFIG,
  DEFAULT_SESSION_MEMORY_TEMPLATE,
  ModelSessionMemoryExtractor,
  SessionMemoryService,
  buildSessionMemoryUpdatePrompt,
  createSessionMemoryRecord,
  evaluateSessionMemoryExtraction,
  isSessionMemoryEmpty,
  truncateSessionMemoryForCompact,
  waitForSessionMemoryIdle,
} from "./context/session-memory";
export { FileSessionMemoryStore, InMemorySessionMemoryStore } from "./context/session-memory-store";
export {
  buildSkillsStatePatch,
  createFileSkillRegistry,
  createSkillsRuntimeState,
  createSkillsSubsystem,
  DefaultSkillExecutor,
  DefaultSkillsService,
  discoverSkills,
  getSkillsRuntimeState,
  InMemorySkillRegistry,
  loadSkillsFromSources,
  parseSkillMarkdown,
  SKILLS_RUNTIME_STATE_KEY,
} from "./skills";
export type {
  SkillDefinition,
  SkillDiscoveryRequest,
  SkillDiscoveryResult,
  SkillExecutionContext,
  SkillExecutionMode,
  SkillExecutionRequest,
  SkillExecutionResult,
  SkillHooks,
  SkillInvocationRecord,
  SkillRegistry,
  SkillShell,
  SkillSource,
  SkillSourceConfig,
  SkillsConfig,
  SkillsRuntimeState,
  SkillsService,
  SkillsSubsystem,
} from "./skills";
export type {
  ContextCompressionLayer,
  ContextManagerConfig,
  ContextThresholdConfig,
  ContextBudgetSnapshot,
  ContextLayerExecution,
  ContextRuntimeState,
  CompactBoundaryRecord,
  ContextCompactionDiagnostic,
  EffectiveRequestSnapshot,
  PreservedContextAsset,
  PreservedContextKind,
} from "./context/types";
export {
  listPreservedContextAssets,
  registerPreservedContextAsset,
  removePreservedContextAsset,
} from "./context/preserved-context";

// --- Prompt Assembly ---
export { PromptAssembler } from "./prompt/assembler";
export type { PromptAssemblyResult, PromptLayer, PromptLayerPhase } from "./prompt/assembler";

// --- Artifacts / Planning / Transport ---
export { ArtifactService, InMemoryArtifactStore } from "./artifact/store";
export type { ArtifactRecord, ArtifactScope, ArtifactStore } from "./artifact/store";
export { createPlanSnapshot, PlanService } from "./planning/service";
export type { PlanSnapshot, PlanStep, PlanStepStatus } from "./planning/service";
export { InMemoryRemoteStoreTransport } from "./transport/store";
export type { RemoteStorePutOptions, RemoteStoreRecord } from "./transport/store";

// --- Recovery / Evaluation / Observability / Policy Packs ---
export { RunbookService } from "./recovery/runbook";
export type { RunbookRule } from "./recovery/runbook";
export { ReplayHarness } from "./evaluation/replay";
export type { ReplaySnapshot } from "./evaluation/replay";
export { InMemoryObservabilitySink, ObservabilityService } from "./observability/service";
export type { ObservabilitySink } from "./observability/service";
export { PolicyPackRegistry } from "./policy-pack";
export type { PolicyPack } from "./policy-pack";

// --- Base Class ---
export { AgentBase } from "./base";

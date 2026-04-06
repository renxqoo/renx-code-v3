export type {
  ArtifactMemoryLayer,
  MemoryAutomationConfig,
  MemoryAutomationState,
  MemoryConfig,
  MemoryEvent,
  MemoryExtractor,
  MemoryExtractionInput,
  MemoryExtractionResult,
  MemoryGovernanceConfig,
  MemoryHooks,
  MemoryNamedContentEntry,
  MemoryPolicy,
  MemoryRecentFileEntry,
  ResolvedMemorySnapshot,
  MemoryScope,
  MemoryScopeContext,
  MemoryScopeResolution,
  MemorySemanticEntry,
  MemorySnapshot,
  MemoryStore,
  MemoryTenantPolicy,
  MemoryTaxonomyType,
  MemorySyncState,
  MemorySyncStateStore,
  MemorySubsystem,
  ScopedMemoryStore,
  SemanticMemoryLayer,
  WorkingMemoryLayer,
} from "./types";
export { createMemorySnapshot, mergeMemorySnapshot } from "./snapshot";
export { FileMemoryStore, InMemoryMemoryStore } from "./store";
export {
  DEFAULT_MEMORY_AUTOMATION_CONFIG,
  buildMemoryAutomationWindow,
  markMemoryAutoSaved,
  mergeMemoryAutomationConfig,
  shouldAutoSaveMemory,
} from "./automation";
export { applyMemoryGovernance, DEFAULT_MEMORY_GOVERNANCE_CONFIG } from "./governance";
export {
  DEFAULT_MEMORY_POLICY,
  applyMemoryPolicy,
  extractScopedMemorySnapshot,
  hasMeaningfulMemory,
} from "./policy";
export { applyMemoryTenantPolicy } from "./tenant-policy";
export { MemoryCommandService } from "./commands";
export { recallMemoryEntries } from "./recall";
export type { MemoryRecallInput } from "./recall";
export { FileScopedMemoryStore, InMemoryScopedMemoryStore } from "./scoped-store";
export { checkSharedMemorySnapshotForSecrets, scanMemorySecrets } from "./secret-guard";
export type { SharedMemorySecretIssue, SharedMemorySecretReport } from "./secret-guard";
export type { SecretMatch as MemorySecretMatch } from "./secret-scanner";
export {
  FileMemorySyncStateStore,
  InMemoryMemorySyncStateStore,
  MemorySnapshotSyncService,
  getMemorySnapshotUpdatedAt,
} from "./sync";
export {
  createMemoryTeamSyncState,
  decodeRemoteMemoryEntryKey,
  InMemoryMemoryRemoteTransport,
  MemoryTeamSyncService,
} from "./team-sync";
export type {
  MemoryRemoteEntry,
  MemoryRemotePullResult,
  MemoryRemotePushResult,
  MemoryRemoteTransport,
  MemoryTeamSyncPullResult,
  MemoryTeamSyncPushResult,
  MemoryTeamSyncServiceOptions,
  MemoryTeamSyncState,
} from "./team-sync";
export { inspectMemoryHealth } from "./doctor";
export type { InspectMemoryHealthOptions, MemoryHealthReport, MemoryHealthWarning } from "./doctor";
export {
  MEMORY_TAXONOMY_TYPES,
  buildMemoryTaxonomyPrompt,
  parseMemoryTaxonomyType,
} from "./taxonomy";
export { MemoryWritePipeline } from "./write-pipeline";
export { MemoryService } from "./service";

// Phase 1: memdir (file-based memory storage)
export { FileMemoryDirStore, ensureMemoryDirExists } from "./memdir/store";
export {
  parseFrontmatter,
  type MemoryFrontmatter,
  type ParsedMemoryFile,
} from "./memdir/frontmatter";
export { scanMemoryFiles, readFileInRange, type MemoryFileHeader } from "./memdir/scanner";
export {
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES,
  truncateEntrypointContent,
  formatMemoryManifest,
} from "./memdir/entrypoint";
export {
  getAutoMemPath,
  isAutoMemPath,
  isAutoMemoryEnabled,
  validateMemoryPath,
} from "./memdir/paths";

// Phase 2: freshness
export { memoryAgeDays, memoryAge, memoryFreshnessText, memoryFreshnessNote } from "./freshness";

// Phase 3: prompts
export {
  MEMORY_TYPES,
  parseMemoryType,
  TYPES_SECTION_COMBINED,
  TYPES_SECTION_INDIVIDUAL,
  type MemoryType,
} from "./prompts/types-section";
export { WHAT_NOT_TO_SAVE_SECTION } from "./prompts/what-not-to-save";
export { WHEN_TO_ACCESS_SECTION, MEMORY_DRIFT_CAVEAT } from "./prompts/when-to-access";
export { TRUSTING_RECALL_SECTION } from "./prompts/trusting-recall";
export { MEMORY_FRONTMATTER_EXAMPLE } from "./prompts/frontmatter-example";
export { buildExtractAutoOnlyPrompt, buildExtractCombinedPrompt } from "./prompts/extraction";
export { buildConsolidationPrompt } from "./prompts/dream";
export {
  buildMemoryLines,
  buildMemoryPrompt,
  buildSearchingPastContextSection,
  buildAssistantDailyLogPrompt,
  DIR_EXISTS_GUIDANCE,
  DIRS_EXIST_GUIDANCE,
} from "./prompts/builder";

// Phase 4: ranking
export {
  findRelevantMemories,
  selectRelevantMemories,
  SELECT_MEMORIES_SYSTEM_PROMPT,
  type RelevantMemory,
} from "./ranking/select";

// Phase 5: extractor
export { TurnThrottle } from "./extractor/throttle";
export { CoalescenceBuffer } from "./extractor/coalescence";
export { hasMemoryWritesSince, type SimpleMessage } from "./extractor/mutex";
export { drainPendingExtractions } from "./extractor/drain";
export {
  ExtractionPipeline,
  createExtractionToolGate,
  type ExtractionPipelineConfig,
  type ForkedAgentRunner,
  type ExtractionContext,
  type ExtractionGateConfig,
  type ExtractionEvents,
} from "./extractor/pipeline";

// Phase 6: dream
export { DreamGate, type DreamGateConfig } from "./dream/gate";
export { ConsolidationLock } from "./dream/lock";
export {
  DreamExecutor,
  type DreamExecutorConfig,
  type DreamContext,
  type DreamRunner,
} from "./dream/executor";
export { FileSessionScanner, type SessionScanner } from "./dream/session-scanner";

// Phase 7: kairos
export { getDailyLogPath, appendToDailyLog, ensureLogDir } from "./kairos/log";

// Phase 8: detection
export {
  detectSessionFileType,
  isAutoMemFile,
  memoryScopeForPath,
  type MemoryScope as DetectionMemoryScope,
  isAutoManagedMemoryFile,
  isShellCommandTargetingMemory,
  detectSessionPatternType,
  isMemoryDirectory,
  isAutoManagedMemoryPattern,
  type MemoryDetectionContext,
} from "./detection";

// Phase 9: team-sync security
export { sanitizePathKey, PathTraversalError } from "./team-sync-security";

// Phase 10: /remember skill
export { buildRememberPrompt, REMEMBER_SKILL_NAME } from "./remember-skill";

// Phase 11: secret scanner (full 37-rule gitleaks)
export {
  scanForSecrets,
  redactSecrets,
  getSecretLabel,
  type SecretMatch as ScannerSecretMatch,
  type SecretRule,
} from "./secret-scanner";

// Phase 12: session memory
export {
  DEFAULT_SESSION_MEMORY_EXTRACTOR_CONFIG,
  type SessionMemoryExtractorConfig,
  type SectionSize,
  type SessionMemoryExtractionState,
  type ExtractionRunner,
  type ExtractionContext as SessionExtractionContext,
  createSessionMemoryToolGate,
  SessionMemoryExtractor,
} from "./session-memory";
export { DEFAULT_SESSION_MEMORY_TEMPLATE } from "./session-memory/template";
export {
  getDefaultUpdatePrompt,
  substituteVariables,
  analyzeSectionSizes,
  generateSectionReminders,
  buildSessionMemoryUpdatePrompt,
  truncateSessionMemoryForCompact,
  isSessionMemoryEmpty,
} from "./session-memory/prompts";

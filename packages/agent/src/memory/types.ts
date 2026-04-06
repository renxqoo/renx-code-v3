import type { PreservedContextAsset } from "../context/types";
import type { SessionMemoryRecord, SessionMemorySubsystem } from "../types";
import type { RunMessage } from "../message/types";

export type MemoryScope = "user" | "project" | "local";
export type MemoryTaxonomyType = "user" | "feedback" | "project" | "reference";

export interface MemoryAutomationState {
  lastAutoSavedMessageId?: string;
  lastAutoSavedAt?: string;
}

export interface MemoryRecentFileEntry {
  path: string;
  content?: string;
  updatedAt: string;
  scope?: MemoryScope;
}

export interface MemoryNamedContentEntry {
  name: string;
  path?: string;
  content?: string;
  updatedAt: string;
  scope?: MemoryScope;
}

export interface MemorySemanticEntry {
  id: string;
  title?: string;
  description?: string;
  content: string;
  type?: MemoryTaxonomyType;
  why?: string;
  howToApply?: string;
  tags?: string[];
  updatedAt: string;
  scope?: MemoryScope;
}

export interface WorkingMemoryLayer {
  recentFiles?: MemoryRecentFileEntry[];
  activePlan?: string | Record<string, unknown>;
  skills?: MemoryNamedContentEntry[];
  rules?: MemoryNamedContentEntry[];
  hooks?: unknown;
  mcpInstructions?: unknown;
}

export interface SemanticMemoryLayer {
  entries?: MemorySemanticEntry[];
}

export interface ArtifactMemoryLayer {
  preservedContextAssets?: PreservedContextAsset[];
}

export interface MemorySnapshot {
  [key: string]: unknown;
  working?: WorkingMemoryLayer;
  session?: SessionMemoryRecord;
  semantic?: SemanticMemoryLayer;
  artifacts?: ArtifactMemoryLayer;
  automation?: MemoryAutomationState;
}

export interface ResolvedMemorySnapshot extends MemorySnapshot {
  working: Required<Pick<WorkingMemoryLayer, "recentFiles" | "skills" | "rules">> &
    Omit<WorkingMemoryLayer, "recentFiles" | "skills" | "rules">;
  semantic: Required<Pick<SemanticMemoryLayer, "entries">> & Omit<SemanticMemoryLayer, "entries">;
  artifacts: Required<Pick<ArtifactMemoryLayer, "preservedContextAssets">> &
    Omit<ArtifactMemoryLayer, "preservedContextAssets">;
}

export interface MemoryStore {
  load(runId: string): Promise<MemorySnapshot | null> | MemorySnapshot | null;
  save(runId: string, snapshot: MemorySnapshot): Promise<void> | void;
}

export interface ScopedMemoryStore {
  load(
    scope: MemoryScope,
    namespace: string,
  ): Promise<MemorySnapshot | null> | MemorySnapshot | null;
  save(scope: MemoryScope, namespace: string, snapshot: MemorySnapshot): Promise<void> | void;
}

export interface MemoryScopeResolution {
  user?: string;
  project?: string;
  local?: string;
}

export interface MemoryScopeContext {
  runId: string;
  userId?: string;
  tenantId?: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
}

export interface MemorySyncState {
  syncedFrom: string;
  updatedAt: string;
}

export interface MemorySyncStateStore {
  load(
    scope: MemoryScope,
    namespace: string,
  ): Promise<MemorySyncState | null> | MemorySyncState | null;
  save(scope: MemoryScope, namespace: string, state: MemorySyncState): Promise<void> | void;
}

export interface MemoryPolicy {
  maxRecentFiles: number;
  maxSkills: number;
  maxRules: number;
  maxSemanticEntries: number;
  maxArtifacts: number;
  maxContentChars: number;
}

export interface MemoryAutomationConfig {
  minimumMessages: number;
  maxConversationMessages: number;
  targetScope: MemoryScope;
}

export interface MemoryGovernanceConfig {
  maxEntryAgeDays: number;
  redactEmails: boolean;
  redactSecrets: boolean;
}

export interface MemoryTenantPolicy {
  allowedScopes?: MemoryScope[];
  allowedTaxonomyTypes?: MemoryTaxonomyType[];
  maxRecentFiles?: number;
  maxSkills?: number;
  maxRules?: number;
  maxSemanticEntries?: number;
  maxArtifacts?: number;
  maxContentChars?: number;
  redactEmails?: boolean;
  redactSecrets?: boolean;
  stripRecentFileContent?: boolean;
  stripSkillContent?: boolean;
  stripRuleContent?: boolean;
  stripArtifactContent?: boolean;
}

export interface MemoryExtractionInput {
  runId: string;
  conversation: RunMessage[];
  snapshot: ResolvedMemorySnapshot;
  scopeContext: MemoryScopeContext;
  namespaces: MemoryScopeResolution;
  signal?: AbortSignal;
}

export interface MemoryExtractionResult {
  entries: MemorySemanticEntry[];
}

export interface MemoryExtractor {
  extract(input: MemoryExtractionInput): Promise<MemoryExtractionResult> | MemoryExtractionResult;
}

export interface MemoryEvent {
  type:
    | "memory_auto_save_started"
    | "memory_auto_save_completed"
    | "memory_auto_save_failed"
    | "memory_auto_save_skipped"
    | "memory_scope_persisted"
    | "memory_governed"
    | "memory_team_sync_pull_completed"
    | "memory_team_sync_push_completed"
    | "memory_team_sync_conflict"
    | "memory_team_sync_secret_skipped";
  runId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface MemoryHooks {
  onEvent(event: MemoryEvent): Promise<void> | void;
}

export interface MemoryConfig {
  promptTokenBudget: number;
}

export interface MemorySubsystem {
  store: MemoryStore;
  scopeStore?: ScopedMemoryStore;
  scopeResolver?: (
    input: MemoryScopeContext,
  ) => MemoryScopeResolution | Promise<MemoryScopeResolution>;
  tenantPolicyResolver?: (
    input: MemoryScopeContext,
  ) => MemoryTenantPolicy | Promise<MemoryTenantPolicy>;
  policy?: Partial<MemoryPolicy>;
  automation?: Partial<MemoryAutomationConfig>;
  governance?: Partial<MemoryGovernanceConfig>;
  extractor?: MemoryExtractor;
  hooks?: MemoryHooks;
  session?: SessionMemorySubsystem;
  config?: Partial<MemoryConfig>;
}

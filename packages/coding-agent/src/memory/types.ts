import type { ModelBinding } from "@renx/model";
import type {
  MemoryHooks,
  MemoryScope,
  MemoryRemoteTransport,
  MemoryTenantPolicy,
  MemorySemanticEntry,
  SessionMemoryConfig,
  SessionMemoryHooks,
  SessionMemorySubsystem,
  MemoryService,
  MemoryCommandService,
} from "@renx/agent";
import type { RelevantMemory } from "@renx/agent";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CodingAgentMemoryConfig {
  /** Memory directory for markdown files. Default: ".claude/memory" */
  dir?: string;
  /** Per-run JSON snapshot directory. Default: ".claude/runs" */
  runsDir?: string;

  // --- Model ---
  /**
   * Model binding for extraction / dream sub-agents.
   * If omitted, defaults to the main agent's model binding.
   */
  modelBinding?: ModelBinding;

  // --- Policy ---
  maxSemanticEntries?: number;
  maxContentChars?: number;
  maxRecentFiles?: number;
  maxSkills?: number;
  maxRules?: number;

  // --- Governance ---
  maxEntryAgeDays?: number;
  redactSecrets?: boolean;
  redactEmails?: boolean;

  // --- Automation ---
  minimumMessages?: number;
  targetScope?: MemoryScope;

  // --- Extraction ---
  enableExtraction?: boolean;
  extractionTurnInterval?: number;
  extractionMaxTurns?: number;

  // --- Dream (cross-session consolidation) ---
  enableDream?: boolean;
  dreamMinHours?: number;
  dreamMinSessions?: number;
  transcriptDir?: string;

  // --- Team sync ---
  enableTeamSync?: boolean;
  teamTransport?: MemoryRemoteTransport;
  teamMaxConflictRetries?: number;

  // --- Hooks ---
  hooks?: MemoryHooks;

  // --- Scope ---
  scopeResolver?: (ctx: {
    userId?: string;
    tenantId?: string;
    projectId?: string;
    workspaceId?: string;
  }) => {
    user?: string;
    project?: string;
    local?: string;
  };

  // --- Token budget ---
  /** Maximum estimated tokens for the memory prompt section. Default: 4000 */
  promptTokenBudget?: number;

  // --- Session memory ---
  /** Enable per-run session memory (scratchpad notes that persist across turns). */
  enableSessionMemory?: boolean;
  /** Directory for session memory JSON files. Default: ".claude/session" */
  sessionMemoryDir?: string;
  /** Override the default session memory template. */
  sessionTemplate?: string;
  /** Session memory mode: "sync" (immediate) or "deferred" (background). */
  sessionMode?: "sync" | "deferred";
  /** Override session memory extraction thresholds. */
  sessionConfig?: Partial<SessionMemoryConfig>;
  /** Session memory event hooks. */
  sessionHooks?: SessionMemoryHooks;

  // --- Tenant policy ---
  /** Resolve per-tenant memory restrictions (scope limits, redaction, etc.). */
  tenantPolicyResolver?: (ctx: {
    userId?: string;
    tenantId?: string;
    projectId?: string;
    workspaceId?: string;
  }) => MemoryTenantPolicy;
}

// ---------------------------------------------------------------------------
// Resolved state
// ---------------------------------------------------------------------------

export interface CodingAgentMemoryState {
  /** The MemorySubsystem to pass into createDeepAgent */
  subsystem: import("@renx/agent").MemorySubsystem;
  /** Extra prompt section for the system prompt (memory behavioral instructions) */
  promptSection: string | undefined;
  /** Background orchestrator (null if no background tasks enabled) */
  orchestrator: CodingMemoryOrchestrator | null;
  /** Session memory subsystem (undefined if not enabled) */
  sessionMemory: SessionMemorySubsystem | undefined;
  /** High-level memory service for lifecycle management */
  memoryService: MemoryService;
  /** CRUD command service for scoped memory operations */
  commandService: MemoryCommandService;
}

// ---------------------------------------------------------------------------
// Orchestrator (background tasks)
// ---------------------------------------------------------------------------

export interface CodingMemoryOrchestrator {
  /** Drain all pending extraction work and stop. Call at shutdown. */
  drain(timeoutMs?: number): Promise<void>;
  /** Run a single dream consolidation cycle. */
  runDreamOnce?(currentSessionId?: string): Promise<boolean>;
  /** Run a team sync cycle (pull then push). */
  runTeamSync?(
    scope: MemoryScope,
    namespace: string,
  ): Promise<{ pullStatus: string; pushStatus: string } | null>;
  /** Recall memory entries matching a query. */
  recall(
    scope: MemoryScope,
    namespace: string,
    query?: string,
    limit?: number,
  ): Promise<MemorySemanticEntry[]>;
  /** AI-powered ranking: find the most relevant memory files for a query. */
  findRelevant?(
    query: string,
    signal: AbortSignal,
    recentTools?: readonly string[],
  ): Promise<RelevantMemory[]>;
}

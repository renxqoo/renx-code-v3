/**
 * Factory for building a MemorySubsystem configured for coding-agent use.
 *
 * Reads a CodingAgentMemoryConfig and produces:
 *   - MemorySubsystem (for injection into createDeepAgent)
 *   - Prompt section (memory behavioral instructions for system prompt)
 *   - Orchestrator (optional background tasks)
 *   - SessionMemorySubsystem (optional per-run scratchpad)
 *   - MemoryService / MemoryCommandService (high-level APIs)
 */

import { resolve, sep, join } from "node:path";
import { readFile } from "node:fs/promises";
import type {
  MemorySubsystem,
  MemoryScope,
  MemoryScopeContext,
  MemoryExtractor,
  MemoryExtractionInput,
  MemoryExtractionResult,
  SessionMemorySubsystem,
} from "@renx/agent";
import {
  FileMemoryStore,
  FileMemoryDirStore,
  ensureMemoryDirExists,
  buildMemoryPrompt,
  scanMemoryFiles,
  ExtractionPipeline,
  DreamExecutor,
  FileSessionScanner,
  MemoryTeamSyncService,
  createMemoryTeamSyncState,
  MemoryService,
  MemoryCommandService,
  ModelSessionMemoryExtractor,
  findRelevantMemories,
} from "@renx/agent";
import type {
  ForkedAgentRunner,
  DreamRunner,
  MemoryTeamSyncState,
  RelevantMemory,
} from "@renx/agent";
import type { ModelBinding, ModelClient } from "@renx/model";
import type {
  CodingAgentMemoryConfig,
  CodingAgentMemoryState,
  CodingMemoryOrchestrator,
} from "./types";
import { createCodingMemoryRunner, createCodingDreamRunner } from "./runner";
import { FileSessionMemoryStore } from "./session-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip undefined values to satisfy exactOptionalPropertyTypes. */
const stripUndefined = <T extends Record<string, unknown>>(
  obj: Record<string, T[keyof T] | undefined>,
): T => {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SEMANTIC_ENTRIES = 100;
const DEFAULT_MAX_CONTENT_CHARS = 5000;
const DEFAULT_MAX_RECENT_FILES = 10;
const DEFAULT_MAX_SKILLS = 20;
const DEFAULT_MAX_RULES = 20;
const DEFAULT_MAX_ENTRY_AGE_DAYS = 90;
const DEFAULT_MIN_MESSAGES = 6;
const DEFAULT_TARGET_SCOPE: MemoryScope = "project";
const DEFAULT_EXTRACTION_TURN_INTERVAL = 4;
const DEFAULT_EXTRACTION_MAX_TURNS = 5;
const DEFAULT_DREAM_MIN_HOURS = 24;
const DEFAULT_DREAM_MIN_SESSIONS = 5;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a MemorySubsystem and optional orchestrator from a coding-agent memory
 * configuration.
 */
export const createCodingMemorySubsystem = async (
  config: CodingAgentMemoryConfig,
  fallbackModelBinding?: ModelBinding,
): Promise<CodingAgentMemoryState> => {
  // --- Resolve directories ---
  const memoryDir = resolve(config.dir ?? `.claude${sep}memory`);
  const runsDir = resolve(config.runsDir ?? `.claude${sep}runs`);
  ensureMemoryDirExists(memoryDir);

  // --- Stores ---
  const store = new FileMemoryStore(runsDir);
  const scopeStore = new FileMemoryDirStore(memoryDir);

  // --- Prompt ---
  let promptSection: string | undefined;
  try {
    const entrypointPath = join(memoryDir, "MEMORY.md");
    const entrypointContent = await readFile(entrypointPath, "utf-8").catch(() => "");
    promptSection = buildMemoryPrompt({
      displayName: "memory",
      memoryDir,
      entrypointContent,
    });
  } catch {
    promptSection = undefined;
  }

  // --- Helper: extract scope context metadata ---
  const extractMeta = (ctx: MemoryScopeContext) => {
    const meta = ctx.metadata ?? {};
    return {
      projectId:
        typeof meta["projectId"] === "string"
          ? (meta["projectId"] as string)
          : typeof meta["projectMemoryKey"] === "string"
            ? (meta["projectMemoryKey"] as string)
            : undefined,
      workspaceId:
        typeof meta["workspaceId"] === "string" ? (meta["workspaceId"] as string) : undefined,
    };
  };

  // --- Scope resolver ---
  const scopeResolver = config.scopeResolver
    ? (ctx: Parameters<NonNullable<MemorySubsystem["scopeResolver"]>>[0]) => {
        const { projectId, workspaceId } = extractMeta(ctx);
        return config.scopeResolver!(
          stripUndefined({
            userId: ctx.userId,
            tenantId: ctx.tenantId,
            projectId,
            workspaceId,
          }),
        );
      }
    : undefined;

  // --- Tenant policy resolver ---
  const rawTenantPolicyResolver = config.tenantPolicyResolver;
  const tenantPolicyResolver = rawTenantPolicyResolver
    ? (ctx: MemoryScopeContext) => {
        const { projectId, workspaceId } = extractMeta(ctx);
        return rawTenantPolicyResolver(
          stripUndefined({
            userId: ctx.userId,
            tenantId: ctx.tenantId,
            projectId,
            workspaceId,
          }),
        );
      }
    : undefined;

  // --- Background subsystems ---
  let orchestrator: CodingMemoryOrchestrator | null = null;
  let extractor: MemoryExtractor | undefined;

  const enableExtraction = config.enableExtraction ?? false;
  const enableDream = config.enableDream ?? false;
  const enableTeamSync = config.enableTeamSync ?? false;

  const modelBinding = config.modelBinding ?? fallbackModelBinding;

  if (enableExtraction || enableDream || enableTeamSync) {
    if (!modelBinding) {
      throw new Error(
        "CodingAgentMemoryConfig.modelBinding (or a resolved model) is required " +
          "when extraction, dream, or teamSync is enabled",
      );
    }

    // --- Extraction pipeline ---
    let pipeline: ExtractionPipeline | undefined;
    if (enableExtraction) {
      const runner: ForkedAgentRunner = createCodingMemoryRunner({ modelBinding });
      pipeline = new ExtractionPipeline(
        {
          turnInterval: config.extractionTurnInterval ?? DEFAULT_EXTRACTION_TURN_INTERVAL,
          maxTurns: config.extractionMaxTurns ?? DEFAULT_EXTRACTION_MAX_TURNS,
        },
        runner,
      );

      extractor = {
        async extract(input: MemoryExtractionInput): Promise<MemoryExtractionResult> {
          const messages = input.conversation.map((m) => ({
            type: m.role as string,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          }));
          await pipeline!.execute(
            {
              messages,
              modelVisibleCount: input.conversation.length,
              memoryDir,
              scanMemoryFiles,
            },
            {
              isSubagent: false,
              autoMemoryEnabled: true,
              isRemoteMode: false,
              extractionEnabled: true,
            },
          );

          return { entries: [] };
        },
      };
    }

    // --- Dream executor ---
    let dreamExecutor: DreamExecutor | undefined;
    if (enableDream) {
      const dreamRunner: DreamRunner = createCodingDreamRunner({ modelBinding });
      dreamExecutor = new DreamExecutor(
        {
          minHours: config.dreamMinHours ?? DEFAULT_DREAM_MIN_HOURS,
          minSessions: config.dreamMinSessions ?? DEFAULT_DREAM_MIN_SESSIONS,
        },
        dreamRunner,
        new FileSessionScanner(),
      );
    }

    // --- Team sync ---
    let teamSync: MemoryTeamSyncService | undefined;
    let teamSyncState: MemoryTeamSyncState | undefined;
    if (enableTeamSync && config.teamTransport) {
      teamSyncState = createMemoryTeamSyncState();
      teamSync = new MemoryTeamSyncService(scopeStore, config.teamTransport, {
        maxConflictRetries: config.teamMaxConflictRetries ?? 2,
      });
    }

    orchestrator = new CodingMemoryOrchestratorImpl(
      pipeline,
      dreamExecutor,
      enableDream ? memoryDir : undefined,
      config.transcriptDir,
      teamSync,
      teamSyncState,
      scopeStore,
      memoryDir,
      modelBinding,
    );
  } else if (modelBinding) {
    // Minimal orchestrator with recall/ranking even without extraction/dream/teamSync.
    orchestrator = new CodingMemoryOrchestratorImpl(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      scopeStore,
      memoryDir,
      modelBinding,
    );
  }

  // --- Session memory subsystem ---
  let sessionMemory: SessionMemorySubsystem | undefined;
  if (config.enableSessionMemory) {
    const sessionDir = resolve(config.sessionMemoryDir ?? `.claude${sep}session`);
    const sessionStore = new FileSessionMemoryStore(sessionDir);

    const sessionExtractor = modelBinding
      ? new ModelSessionMemoryExtractor(modelBinding.client, modelBinding.name)
      : undefined;

    sessionMemory = {
      store: sessionStore,
      ...(sessionExtractor ? { extractor: sessionExtractor } : {}),
      ...(config.sessionConfig ? { config: config.sessionConfig } : {}),
      ...(config.sessionMode ? { mode: config.sessionMode } : {}),
      ...(config.sessionTemplate ? { template: config.sessionTemplate } : {}),
      ...(config.sessionHooks ? { hooks: config.sessionHooks } : {}),
    };
  }

  // --- Build MemorySubsystem ---
  const subsystem: MemorySubsystem = {
    store,
    scopeStore,
    ...(scopeResolver ? { scopeResolver } : {}),
    ...(tenantPolicyResolver ? { tenantPolicyResolver } : {}),
    policy: {
      maxSemanticEntries: config.maxSemanticEntries ?? DEFAULT_MAX_SEMANTIC_ENTRIES,
      maxContentChars: config.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS,
      maxRecentFiles: config.maxRecentFiles ?? DEFAULT_MAX_RECENT_FILES,
      maxSkills: config.maxSkills ?? DEFAULT_MAX_SKILLS,
      maxRules: config.maxRules ?? DEFAULT_MAX_RULES,
    },
    automation: {
      minimumMessages: config.minimumMessages ?? DEFAULT_MIN_MESSAGES,
      targetScope: config.targetScope ?? DEFAULT_TARGET_SCOPE,
    },
    governance: {
      maxEntryAgeDays: config.maxEntryAgeDays ?? DEFAULT_MAX_ENTRY_AGE_DAYS,
      redactSecrets: config.redactSecrets ?? true,
      redactEmails: config.redactEmails ?? true,
    },
    ...(config.hooks ? { hooks: config.hooks } : {}),
    ...(extractor ? { extractor } : {}),
    ...(sessionMemory ? { session: sessionMemory } : {}),
    ...(config.promptTokenBudget
      ? { config: { promptTokenBudget: config.promptTokenBudget } }
      : {}),
  };

  // --- High-level services ---
  const memoryService = new MemoryService(subsystem);
  const commandService = new MemoryCommandService(scopeStore, subsystem.policy);

  return {
    subsystem,
    promptSection,
    orchestrator,
    sessionMemory,
    memoryService,
    commandService,
  };
};

// ---------------------------------------------------------------------------
// Orchestrator implementation
// ---------------------------------------------------------------------------

class CodingMemoryOrchestratorImpl implements CodingMemoryOrchestrator {
  constructor(
    private readonly pipeline: ExtractionPipeline | undefined,
    private readonly dreamExecutor: DreamExecutor | undefined,
    private readonly dreamMemoryDir?: string,
    private readonly dreamTranscriptDir?: string,
    private readonly teamSync?: MemoryTeamSyncService,
    private readonly teamSyncState?: MemoryTeamSyncState,
    private readonly scopeStore?: import("@renx/agent").ScopedMemoryStore,
    private readonly memoryDir?: string,
    private readonly modelBinding?: ModelBinding,
  ) {}

  async drain(timeoutMs: number = 30_000): Promise<void> {
    await this.pipeline?.drain(timeoutMs);
  }

  async runDreamOnce(currentSessionId?: string): Promise<boolean> {
    if (!this.dreamExecutor || !this.dreamMemoryDir || !this.dreamTranscriptDir) {
      return false;
    }
    const context = {
      memoryDir: this.dreamMemoryDir,
      transcriptDir: this.dreamTranscriptDir,
      ...(currentSessionId ? { currentSessionId } : {}),
    };
    return this.dreamExecutor.execute(context);
  }

  async runTeamSync(
    scope: MemoryScope,
    namespace: string,
  ): Promise<{ pullStatus: string; pushStatus: string } | null> {
    if (!this.teamSync || !this.teamSyncState) return null;

    const pullResult = await this.teamSync.pull({
      scope,
      namespace,
      state: this.teamSyncState,
    });
    const pushResult = await this.teamSync.push({
      scope,
      namespace,
      state: this.teamSyncState,
    });

    return {
      pullStatus: pullResult.status,
      pushStatus: pushResult.status,
    };
  }

  async recall(
    scope: MemoryScope,
    namespace: string,
    query?: string,
    limit?: number,
  ): Promise<import("@renx/agent").MemorySemanticEntry[]> {
    if (!this.scopeStore) return [];
    const cmdService = new MemoryCommandService(this.scopeStore);
    const input: {
      scope: MemoryScope;
      namespace: string;
      query?: string;
      limit?: number;
    } = { scope, namespace };
    if (query !== undefined) input.query = query;
    if (limit !== undefined) input.limit = limit;
    return cmdService.recall(input);
  }

  async findRelevant(
    query: string,
    signal: AbortSignal,
    recentTools: readonly string[] = [],
  ): Promise<RelevantMemory[]> {
    if (!this.modelBinding || !this.memoryDir) return [];
    return findRelevantMemories(
      this.modelBinding.client,
      this.modelBinding.name,
      query,
      this.memoryDir,
      scanMemoryFiles,
      signal,
      recentTools,
    );
  }
}

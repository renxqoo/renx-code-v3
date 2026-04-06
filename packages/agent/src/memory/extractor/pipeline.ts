/**
 * Extraction pipeline orchestration.
 *
 * Wires together the throttle, coalescence, mutex, and drain modules
 * into a working extraction pipeline that mirrors
 * claude-code-source/src/services/extractMemories/extractMemories.ts.
 *
 * The SDK architecture uses dependency injection instead of global state.
 * All stateful components (throttle, coalescence buffer, in-flight set)
 * are instance-owned.
 */

import { TurnThrottle } from "./throttle";
import { CoalescenceBuffer } from "./coalescence";
import { hasMemoryWritesSince, type SimpleMessage } from "./mutex";
import { drainPendingExtractions } from "./drain";
import { buildExtractAutoOnlyPrompt, buildExtractCombinedPrompt } from "../prompts/extraction";
import { isAutoMemPath } from "../memdir/paths";
import { basename } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExtractionPipelineConfig {
  /** Run extraction every N eligible turns. Default: 1 (every turn). */
  turnInterval: number;
  /** Maximum turns the forked agent may use. Default: 5. */
  maxTurns: number;
  /** Whether team memory is enabled (affects prompt selection). Default: false. */
  teamEnabled: boolean;
  /** Skip the MEMORY.md index step in the prompt. Default: false. */
  skipIndex: boolean;
}

const DEFAULT_CONFIG: Readonly<ExtractionPipelineConfig> = {
  turnInterval: 1,
  maxTurns: 5,
  teamEnabled: false,
  skipIndex: false,
};

export interface ForkedAgentRunner {
  run(params: {
    systemPrompt: string;
    messages: Array<{ role: string; content: string }>;
    maxTurns: number;
    canUseTool: (toolName: string, input: unknown) => boolean | string;
  }): Promise<{
    success: boolean;
    tokenUsage?: number;
    /** Paths written by the agent (Edit/Write tool calls). */
    writtenPaths?: string[];
  }>;
}

export interface ExtractionContext {
  /** Full conversation messages (used for mutex check and as extraction input). */
  messages: SimpleMessage[];
  /** Number of recent messages visible to the model (used for prompt header). */
  modelVisibleCount: number;
  /** Absolute path to the auto-memory directory. */
  memoryDir: string;
  /** Scan the memory dir for existing files (for the manifest section). */
  scanMemoryFiles: (dir: string) => Promise<Array<{ filename: string; mtimeMs: number }>>;
}

/**
 * Gate checks for extraction pipeline.
 * Allows the SDK host to control when extraction is permitted.
 */
export interface ExtractionGateConfig {
  /** Whether this is a subagent (skip extraction if true). */
  isSubagent?: boolean;
  /** Whether auto-memory extraction is enabled. */
  autoMemoryEnabled?: boolean;
  /** Whether running in remote/headless mode (skip extraction if true). */
  isRemoteMode?: boolean;
  /** Whether the extraction feature is enabled (feature flag equivalent). */
  extractionEnabled?: boolean;
}

export interface ExtractionEvents {
  /** Called after memories are saved successfully. */
  onMemorySaved?: (paths: string[]) => void;
  /** Called when extraction is skipped due to gate. */
  onGateDisabled?: () => void;
  /** Called when context is coalesced for trailing run. */
  onCoalesced?: () => void;
  /** Called on extraction error. */
  onError?: (error: unknown) => void;
  /** Called with token usage after a run. */
  onTokenUsage?: (usage: {
    tokenUsage?: number;
    writtenPaths?: string[];
    durationMs: number;
  }) => void;
}

// ---------------------------------------------------------------------------
// Tool permission gate
// ---------------------------------------------------------------------------

/** Tool names that the extraction subagent is allowed to use. */
const ALLOWED_READ_TOOLS: ReadonlySet<string> = new Set(["Read", "Grep", "Glob"]);

/** Write-capable tools that are gated to memory-dir paths only. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write"]);

/**
 * Bash commands that are permitted for the extraction subagent.
 * Only read-only informational commands — rm and other write-capable
 * commands are denied.
 */
const ALLOWED_BASH_PREFIXES: ReadonlyArray<string> = [
  "ls",
  "find",
  "cat",
  "stat",
  "wc",
  "head",
  "tail",
  "md5sum",
  "sha256sum",
  "file",
  "grep",
  "rg",
];

/**
 * Create a tool permission gate that restricts the forked extraction agent
 * to read tools, memory-scoped writes, and read-only bash commands.
 *
 * 1:1 replicate of the canUseTool logic from
 * claude-code-source/src/services/extractMemories/extractMemories.ts.
 */
export function createExtractionToolGate(
  memoryDir: string,
): (toolName: string, input: unknown) => boolean | string {
  return (toolName: string, input: unknown): boolean | string => {
    // Read-only tools are always allowed
    if (ALLOWED_READ_TOOLS.has(toolName)) {
      return true;
    }

    // Edit / Write — only if the target path is inside the memory directory
    if (WRITE_TOOLS.has(toolName)) {
      const filePath = extractFilePath(input);
      if (typeof filePath === "string" && isAutoMemPath(filePath, memoryDir)) {
        return true;
      }
      return "File path is outside the memory directory.";
    }

    // Bash — allow only a whitelist of read-only command prefixes
    if (toolName === "Bash") {
      const command = extractCommand(input);
      if (typeof command === "string" && isAllowedBashCommand(command)) {
        return true;
      }
      return "Only read-only bash commands are permitted.";
    }

    // Everything else (MCP, Agent, NotebookEdit, etc.) is denied
    return `Tool "${toolName}" is not available for memory extraction.`;
  };
}

/**
 * Extract file_path from a tool input object.
 */
function extractFilePath(input: unknown): string | undefined {
  if (typeof input === "object" && input !== null && "file_path" in input) {
    const fp = (input as Record<string, unknown>).file_path;
    return typeof fp === "string" ? fp : undefined;
  }
  return undefined;
}

/**
 * Extract command from a Bash tool input object.
 */
function extractCommand(input: unknown): string | undefined {
  if (typeof input === "object" && input !== null && "command" in input) {
    const cmd = (input as Record<string, unknown>).command;
    return typeof cmd === "string" ? cmd : undefined;
  }
  return undefined;
}

/**
 * Check whether a bash command starts with an allowed read-only prefix.
 * Strips leading whitespace and handles pipe chains conservatively.
 */
function isAllowedBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;

  // Deny rm explicitly regardless of position
  if (/\brm\s/.test(trimmed) || trimmed === "rm") return false;

  // Check first token against allowlist
  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  const base = basename(firstToken);
  return ALLOWED_BASH_PREFIXES.some(
    (prefix) => base === prefix || base.endsWith("/" + prefix) || base.endsWith("\\" + prefix),
  );
}

// ---------------------------------------------------------------------------
// Stashed context shape (internal)
// ---------------------------------------------------------------------------

interface StashedContext {
  messages: SimpleMessage[];
  modelVisibleCount: number;
  memoryDir: string;
}

// ---------------------------------------------------------------------------
// ExtractionPipeline
// ---------------------------------------------------------------------------

export class ExtractionPipeline {
  private readonly config: ExtractionPipelineConfig;
  private readonly runner: ForkedAgentRunner;
  private readonly throttle: TurnThrottle;
  private readonly coalescence: CoalescenceBuffer<StashedContext>;
  private readonly inFlight: Set<Promise<void>>;
  private readonly events: ExtractionEvents;
  private extractionInProgress: boolean;
  private cursorUuid: string | undefined;
  private hasLoggedGateFailure: boolean;

  constructor(
    config: Partial<ExtractionPipelineConfig>,
    runner: ForkedAgentRunner,
    events?: ExtractionEvents,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.runner = runner;
    this.events = events ?? {};
    this.throttle = new TurnThrottle(this.config.turnInterval);
    this.coalescence = new CoalescenceBuffer<StashedContext>();
    this.inFlight = new Set();
    this.extractionInProgress = false;
    this.cursorUuid = undefined;
    this.hasLoggedGateFailure = false;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Main entry point — called after each agent turn.
   *
   * Flow (matching claude-code-source):
   *  0. Gate checks (subagent, feature flag, auto-memory enabled, remote mode)
   *  1. Mutex check — skip if main agent already wrote memories
   *  2. Throttle check — skip if not enough turns elapsed
   *  3. If extraction in progress — coalesce context for trailing run
   *  4. Build prompt and launch forked agent
   *  5. Track in-flight promise
   *  6. On completion — consume coalesced context for trailing run
   *  7. Advance cursor on success
   */
  async execute(context: ExtractionContext, gates?: ExtractionGateConfig): Promise<void> {
    // 0. Gate checks (matching reference extractMemories.ts lines 531-552)
    if (gates?.isSubagent) {
      return;
    }

    if (gates?.extractionEnabled === false) {
      if (!this.hasLoggedGateFailure) {
        this.hasLoggedGateFailure = true;
        this.events.onGateDisabled?.();
      }
      return;
    }

    if (gates?.autoMemoryEnabled === false) {
      return;
    }

    if (gates?.isRemoteMode) {
      return;
    }

    // 1. Mutex — skip if main agent already wrote to memory since cursor
    if (
      hasMemoryWritesSince(context.messages, this.cursorUuid, (filePath) =>
        isAutoMemPath(filePath, context.memoryDir),
      )
    ) {
      // The main agent handled it — advance cursor so we don't re-check
      this.advanceCursor(context.messages);
      return;
    }

    // 2. Throttle — only run every N turns
    if (!this.throttle.shouldRun()) {
      return;
    }

    const stash: StashedContext = {
      messages: context.messages,
      modelVisibleCount: context.modelVisibleCount,
      memoryDir: context.memoryDir,
    };

    // 3. If extraction already in progress — coalesce and return
    if (this.extractionInProgress) {
      this.coalescence.stash(stash);
      this.events.onCoalesced?.();
      return;
    }

    // 4. Launch extraction
    await this.runExtraction(stash, context.scanMemoryFiles);
  }

  /**
   * Drain all in-flight extraction promises at shutdown.
   */
  async drain(timeoutMs?: number): Promise<void> {
    await drainPendingExtractions(this.inFlight, timeoutMs);
  }

  /**
   * Reset all internal state (for testing).
   */
  reset(): void {
    this.throttle.reset();
    this.coalescence.consume(); // clear any stashed context
    this.inFlight.clear();
    this.extractionInProgress = false;
    this.cursorUuid = undefined;
    this.hasLoggedGateFailure = false;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /**
   * Run a single extraction and handle trailing runs from coalesced context.
   */
  private async runExtraction(
    stash: StashedContext,
    scanMemoryFiles: ExtractionContext["scanMemoryFiles"],
  ): Promise<void> {
    this.extractionInProgress = true;

    const promise = this.doExtraction(stash, scanMemoryFiles);
    this.inFlight.add(promise);

    try {
      await promise;
    } finally {
      this.inFlight.delete(promise);
    }
  }

  /**
   * Core extraction logic — runs the forked agent, then checks for trailing
   * coalesced context.
   */
  private async doExtraction(
    stash: StashedContext,
    scanMemoryFiles: ExtractionContext["scanMemoryFiles"],
  ): Promise<void> {
    const startTime = Date.now();

    try {
      // Build the extraction prompt
      const systemPrompt = await this.buildSystemPrompt(stash, scanMemoryFiles);

      // Convert messages to the format the forked agent expects
      const agentMessages = this.buildAgentMessages(stash);

      // Create the tool gate
      const canUseTool = createExtractionToolGate(stash.memoryDir);

      // Run the forked agent
      const result = await this.runner.run({
        systemPrompt,
        messages: agentMessages,
        maxTurns: this.config.maxTurns,
        canUseTool,
      });

      const durationMs = Date.now() - startTime;

      if (result.success) {
        // Advance cursor past the messages we just extracted from
        this.advanceCursor(stash.messages);

        // Report token usage and written paths
        // Build payload carefully for exactOptionalPropertyTypes: omit keys
        // whose values are undefined rather than passing undefined explicitly.
        this.events.onTokenUsage?.({
          ...(result.tokenUsage != null ? { tokenUsage: result.tokenUsage } : {}),
          ...(result.writtenPaths != null ? { writtenPaths: result.writtenPaths } : {}),
          durationMs,
        });

        // Notify about saved memories
        if (result.writtenPaths && result.writtenPaths.length > 0) {
          this.events.onMemorySaved?.(result.writtenPaths);
        }
      }
    } catch (err) {
      this.events.onError?.(err);
    } finally {
      this.extractionInProgress = false;

      // Check for trailing run from coalesced context
      const trailing = this.coalescence.consume();
      if (trailing) {
        // Await trailing run inline (matching reference behavior)
        await this.doExtraction(trailing, scanMemoryFiles);
      }
    }
  }

  /**
   * Build the system prompt for the extraction subagent.
   */
  private async buildSystemPrompt(
    stash: StashedContext,
    scanMemoryFiles: ExtractionContext["scanMemoryFiles"],
  ): Promise<string> {
    // Scan for existing memories to include in manifest
    let existingMemories = "";
    try {
      const files = await scanMemoryFiles(stash.memoryDir);
      if (files.length > 0) {
        const lines = files.map((f) => `- ${f.filename}`);
        existingMemories = lines.join("\n");
      }
    } catch {
      // Non-fatal — proceed without manifest
    }

    if (this.config.teamEnabled) {
      return buildExtractCombinedPrompt(
        stash.modelVisibleCount,
        existingMemories,
        this.config.skipIndex,
        true,
      );
    }

    return buildExtractAutoOnlyPrompt(
      stash.modelVisibleCount,
      existingMemories,
      this.config.skipIndex,
    );
  }

  /**
   * Convert SimpleMessage[] to the forked agent's message format.
   *
   * Filters to the visible window and extracts string content.
   */
  private buildAgentMessages(stash: StashedContext): Array<{
    role: string;
    content: string;
  }> {
    const messages = stash.messages;
    const visibleCount = stash.modelVisibleCount;
    const start = Math.max(0, messages.length - visibleCount);
    const window = messages.slice(start);

    const result: Array<{ role: string; content: string }> = [];

    for (const msg of window) {
      const role = msg.type === "assistant" ? "assistant" : "user";
      const content = stringifyContent(msg.content);
      if (content.length > 0) {
        result.push({ role, content });
      }
    }

    return result;
  }

  /**
   * Advance the cursor to the UUID of the last message in the array,
   * so subsequent mutex checks only scan messages after this point.
   */
  private advanceCursor(messages: SimpleMessage[]): void {
    if (messages.length === 0) return;
    // Walk backwards to find the last message with a UUID
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg !== undefined && msg.uuid !== undefined) {
        this.cursorUuid = msg.uuid;
        return;
      }
    }
    // If no UUID found, leave cursor unchanged
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Coerce unknown content to a string for the forked agent message format.
 */
function stringifyContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    // Anthropic content blocks — extract text blocks
    const parts: string[] = [];
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        (block as { type: string }).type === "text" &&
        "text" in block
      ) {
        const text = (block as { text: unknown }).text;
        if (typeof text === "string") {
          parts.push(text);
        }
      }
    }
    return parts.join("\n");
  }

  if (content === null || content === undefined) {
    return "";
  }

  return String(content);
}

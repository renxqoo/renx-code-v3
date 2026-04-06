/**
 * Session memory module - public API.
 *
 * Re-exports everything from the sub-modules and provides the
 * {@link SessionMemoryExtractor} class which encapsulates the threshold-based
 * extraction decision logic and the actual extraction orchestration.
 *
 * Design notes
 * ------------
 * The extractor is intentionally a plain class with dependency-injected
 * collaborators (no globals, no singletons).  This makes it straightforward
 * to test in isolation and to swap out individual parts (e.g. the token
 * estimator) without touching unrelated code.
 *
 * @module session-memory
 */

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export {
  type SessionMemoryExtractorConfig,
  type SectionSize,
  type SessionMemoryExtractionState,
  DEFAULT_SESSION_MEMORY_EXTRACTOR_CONFIG,
  createExtractionState,
} from "./types";

export { DEFAULT_SESSION_MEMORY_TEMPLATE } from "./template";

export {
  getDefaultUpdatePrompt,
  substituteVariables,
  analyzeSectionSizes,
  generateSectionReminders,
  buildSessionMemoryUpdatePrompt,
  truncateSessionMemoryForCompact,
  isSessionMemoryEmpty,
} from "./prompts";

// ---------------------------------------------------------------------------
// Imports used locally
// ---------------------------------------------------------------------------

import type { SessionMemoryExtractorConfig, SessionMemoryExtractionState } from "./types";
import { DEFAULT_SESSION_MEMORY_EXTRACTOR_CONFIG, createExtractionState } from "./types";
import type { RunMessage } from "../../message/types";
import { buildSessionMemoryUpdatePrompt } from "./prompts";

// ---------------------------------------------------------------------------
// Token estimation helpers
// ---------------------------------------------------------------------------

/**
 * A function that estimates the token count for a string.
 *
 * The default implementation uses a chars/4 heuristic which is sufficient
 * for threshold checks.  Callers can supply a more accurate estimator
 * (e.g. tiktoken) via dependency injection.
 */
export type TokenEstimator = (text: string) => number;

const defaultTokenEstimator: TokenEstimator = (text: string): number =>
  Math.max(1, Math.ceil(text.length / 4));

const estimateMessagesTokens = (messages: RunMessage[], estimator: TokenEstimator): number =>
  messages.reduce((total, message) => {
    const toolCallTokens = JSON.stringify(message.toolCalls ?? []).length;
    return total + estimator(message.content) + Math.ceil(toolCallTokens / 4);
  }, 0);

// ---------------------------------------------------------------------------
// Internal message helpers
// ---------------------------------------------------------------------------

const countToolCallsSince = (messages: RunMessage[], sinceMessageId: string | null): number => {
  let foundStart = sinceMessageId === null;
  let count = 0;
  for (const message of messages) {
    if (!foundStart) {
      if (message.id === sinceMessageId || message.messageId === sinceMessageId) {
        foundStart = true;
      }
      continue;
    }
    count += message.toolCalls?.length ?? 0;
  }
  return count;
};

const hasToolCallsInLastAssistantTurn = (messages: RunMessage[]): boolean => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    if (message.role !== "assistant") continue;
    return (message.toolCalls?.length ?? 0) > 0;
  }
  return false;
};

// ---------------------------------------------------------------------------
// Extraction runner interface
// ---------------------------------------------------------------------------

/**
 * Abstraction over the actual subagent execution.  In production this would
 * be backed by a forked agent / model call; in tests it can be a stub.
 */
export interface ExtractionRunner {
  run(prompt: string, options?: { signal?: AbortSignal }): Promise<string>;
}

// ---------------------------------------------------------------------------
// Extraction context
// ---------------------------------------------------------------------------

/**
 * Bundle of everything the extractor needs to perform one extraction pass.
 */
export interface ExtractionContext {
  runId: string;
  messages: RunMessage[];
  notesPath: string;
  currentNotes: string;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Should-extract result
// ---------------------------------------------------------------------------

export interface ShouldExtractResult {
  shouldExtract: boolean;
  currentTokenCount: number;
  nextState: SessionMemoryExtractionState;
}

// ---------------------------------------------------------------------------
// Tool gate
// ---------------------------------------------------------------------------

/**
 * Represents a tool call that is being gated.
 */
interface GatedToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * Creates a filter function that only permits Edit tool calls targeting the
 * exact session memory file path.  All other tool calls are silently
 * rejected (returned as empty).
 *
 * This is used when running a subagent so that the only side-effect it can
 * produce is editing the session memory notes file.
 */
export function createSessionMemoryToolGate(
  memoryPath: string,
): (toolCalls: GatedToolCall[]) => GatedToolCall[] {
  return (toolCalls: GatedToolCall[]): GatedToolCall[] => {
    return toolCalls.filter((tc) => {
      if (tc.name !== "Edit" && tc.name !== "edit") return false;
      const args = tc.arguments ?? {};
      const filePath =
        (args.file_path as string | undefined) ?? (args.path as string | undefined) ?? "";
      // Normalise both paths for comparison
      return filePath.replace(/\\/g, "/") === memoryPath.replace(/\\/g, "/");
    });
  };
}

// ---------------------------------------------------------------------------
// SessionMemoryExtractor
// ---------------------------------------------------------------------------

/**
 * Encapsulates the dual-threshold extraction decision and the orchestration
 * of the actual extraction pass.
 *
 * Threshold logic (mirrors the reference implementation):
 *
 *  1. If not yet initialised, require `minimumMessageTokensToInit` cumulative
 *     tokens.
 *  2. If initialised, require **both**:
 *       a. Token growth >= `minimumTokensBetweenUpdate`, **and**
 *       b. Tool calls since last extraction >= `toolCallsBetweenUpdates`
 *     ...OR require token growth AND the last assistant turn has NO tool
 *     calls (i.e. the agent is "done" for now).
 */
export class SessionMemoryExtractor {
  constructor(
    private readonly config: SessionMemoryExtractorConfig = DEFAULT_SESSION_MEMORY_EXTRACTOR_CONFIG,
    private readonly tokenEstimator: TokenEstimator = defaultTokenEstimator,
  ) {}

  // -----------------------------------------------------------------------
  // shouldExtract
  // -----------------------------------------------------------------------

  /**
   * Evaluates whether an extraction should be triggered given the current
   * conversation state and the extraction history.
   *
   * @param messages  - The full conversation so far.
   * @param state     - The mutable extraction state (persisted across calls).
   * @returns A result indicating whether to extract, the current token count,
   *          and the updated state.
   */
  shouldExtract(messages: RunMessage[], state: SessionMemoryExtractionState): ShouldExtractResult {
    const currentTokenCount = estimateMessagesTokens(messages, this.tokenEstimator);
    const nextState = { ...state };

    // Step 1: initialisation gate
    if (!nextState.initialized) {
      if (currentTokenCount < this.config.minimumMessageTokensToInit) {
        return { shouldExtract: false, currentTokenCount, nextState };
      }
      nextState.initialized = true;
    }

    // Step 2: token growth threshold
    const tokenGrowth = currentTokenCount - nextState.tokensAtLastExtraction;
    const hasMetTokenThreshold = tokenGrowth >= this.config.minimumTokensBetweenUpdate;

    // Step 3: tool-call threshold
    const toolCallsSince = countToolCallsSince(messages, nextState.lastSummarizedMessageId);
    const hasMetToolCallThreshold = toolCallsSince >= this.config.toolCallsBetweenUpdates;

    // Step 4: does the last assistant turn have tool calls?
    const lastTurnHasToolCalls = hasToolCallsInLastAssistantTurn(messages);

    // Step 5: decide
    const shouldExtract =
      (hasMetTokenThreshold && hasMetToolCallThreshold) ||
      (hasMetTokenThreshold && !lastTurnHasToolCalls);

    if (!shouldExtract) {
      return { shouldExtract: false, currentTokenCount, nextState };
    }

    // Update lastSummarizedMessageId
    const lastMessage = messages[messages.length - 1];
    if (lastMessage) {
      nextState.lastSummarizedMessageId = lastMessage.id ?? lastMessage.messageId ?? null;
    }

    return { shouldExtract: true, currentTokenCount, nextState };
  }

  // -----------------------------------------------------------------------
  // extract
  // -----------------------------------------------------------------------

  /**
   * Performs the actual extraction by delegating to the provided
   * {@link ExtractionRunner}.
   *
   * @param context - The extraction context (messages, notes path, etc.).
   * @param runner  - The runner that will execute the subagent.
   * @returns The updated notes content.
   */
  async extract(context: ExtractionContext, runner: ExtractionRunner): Promise<string> {
    const prompt = buildSessionMemoryUpdatePrompt(
      context.currentNotes,
      context.notesPath,
      this.config,
    );
    const opts: { signal?: AbortSignal } = {};
    if (context.signal) opts.signal = context.signal;
    const result = await runner.run(prompt, opts);
    return result.trim();
  }
}

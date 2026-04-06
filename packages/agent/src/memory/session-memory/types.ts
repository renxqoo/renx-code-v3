/**
 * Session memory module - types and configuration.
 *
 * @module session-memory/types
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Tunable parameters that control when session memory is initialised and how
 * often it is refreshed.
 *
 * These are an SDK-level subset of the full {@link SessionMemoryConfig} that
 * lives in `packages/agent/src/types.ts`.  The module-level config is used
 * only by the extractor and prompt utilities that live inside this directory;
 * the agent-wide config additionally carries timeout / polling fields that
 * are consumed by {@link SessionMemoryService}.
 */
export interface SessionMemoryExtractorConfig {
  /** Minimum cumulative message tokens before the first extraction is allowed. */
  minimumMessageTokensToInit: number; // 10 000

  /** Minimum token growth since last extraction before a subsequent update. */
  minimumTokensBetweenUpdate: number; // 5 000

  /** Minimum tool calls since last extraction before a subsequent update. */
  toolCallsBetweenUpdates: number; // 3

  /** Soft per-section token budget. Sections exceeding this are flagged. */
  maxSectionLength: number; // 2 000

  /** Hard total token budget for the entire session memory document. */
  maxTotalSessionMemoryTokens: number; // 12 000
}

/**
 * Sensible production defaults, matching the reference implementation.
 */
export const DEFAULT_SESSION_MEMORY_EXTRACTOR_CONFIG: SessionMemoryExtractorConfig = {
  minimumMessageTokensToInit: 10_000,
  minimumTokensBetweenUpdate: 5_000,
  toolCallsBetweenUpdates: 3,
  maxSectionLength: 2_000,
  maxTotalSessionMemoryTokens: 12_000,
};

// ---------------------------------------------------------------------------
// Section analysis
// ---------------------------------------------------------------------------

/**
 * Represents the measured size of a single markdown section within the
 * session memory document.
 */
export interface SectionSize {
  /** The `# Header` line (including the leading `# `). */
  header: string;
  /** Rough token estimate (chars / 4). */
  estimatedTokens: number;
  /** Number of non-header lines in the section body. */
  lineCount: number;
}

// ---------------------------------------------------------------------------
// Extraction state
// ---------------------------------------------------------------------------

/**
 * Mutable state tracked by the extractor to decide whether a new extraction
 * pass should be triggered.
 *
 * This is intentionally narrower than {@link SessionMemoryRecord} - it only
 * carries the fields needed for threshold evaluation.
 */
export interface SessionMemoryExtractionState {
  /** ID of the last message that was included in a successful extraction. */
  lastSummarizedMessageId: string | null;

  /** ISO timestamp when the current in-flight extraction was started. */
  extractionStartedAt: string | null;

  /** Cumulative token count at the last completed extraction. */
  tokensAtLastExtraction: number;

  /** Whether the initial extraction has been performed. */
  initialized: boolean;
}

/**
 * A factory that creates a fresh {@link SessionMemoryExtractionState}.
 */
export const createExtractionState = (
  overrides?: Partial<SessionMemoryExtractionState>,
): SessionMemoryExtractionState => ({
  lastSummarizedMessageId: null,
  extractionStartedAt: null,
  tokensAtLastExtraction: 0,
  initialized: false,
  ...overrides,
});

import { createMemorySnapshot } from "./snapshot";
import type { MemorySemanticEntry, MemorySnapshot } from "./types";

export interface MemoryRecallInput {
  query?: string;
  explicit?: boolean;
  ignoreMemory?: boolean;
  limit?: number;
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "into",
  "should",
  "would",
  "could",
  "what",
  "when",
  "where",
  "about",
  "have",
  "has",
  "had",
  "you",
  "your",
  "our",
  "are",
  "was",
  "were",
]);

const tokenize = (value: string | undefined): string[] =>
  (value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_./:-]+/i)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));

const countOverlap = (haystack: string[], needles: string[]): number =>
  haystack.reduce((count, token) => count + (needles.includes(token) ? 1 : 0), 0);

const scoreEntry = (
  entry: MemorySemanticEntry,
  queryTokens: string[],
  explicit: boolean,
): {
  overlap: number;
  score: number;
} => {
  const corpusTokens = tokenize(
    [
      entry.id,
      entry.title,
      entry.description,
      entry.content,
      entry.why,
      entry.howToApply,
      ...(entry.tags ?? []),
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" "),
  );
  const overlap = countOverlap(corpusTokens, queryTokens);
  const recency = Date.parse(entry.updatedAt);
  const normalizedRecency = Number.isFinite(recency) ? recency / 1_000_000_000_000 : 0;
  const explicitBoost = explicit && queryTokens.length === 0 ? 0.25 : 0;
  return {
    overlap,
    score: overlap * 10 + normalizedRecency + explicitBoost,
  };
};

export const recallMemoryEntries = (
  snapshot: MemorySnapshot | undefined,
  input: MemoryRecallInput,
): MemorySemanticEntry[] => {
  if (input.ignoreMemory) return [];
  const normalized = createMemorySnapshot(snapshot);
  const entries = normalized.semantic.entries;
  if (entries.length === 0) return [];

  const queryTokens = tokenize(input.query);
  const scored = entries
    .map((entry) => ({
      entry,
      ...scoreEntry(entry, queryTokens, input.explicit ?? false),
    }))
    .filter(({ score, overlap }) =>
      input.explicit ? (queryTokens.length > 0 ? overlap > 0 : score > 0) : score >= 10,
    )
    .sort((left, right) => right.score - left.score);

  if (scored.length > 0) {
    return scored.slice(0, input.limit ?? 6).map(({ entry }) => entry);
  }

  const fallback = [...entries].sort((left, right) => {
    const leftPriority =
      left.type === "user" || left.type === "feedback" || left.type === undefined ? 1 : 0;
    const rightPriority =
      right.type === "user" || right.type === "feedback" || right.type === undefined ? 1 : 0;
    if (rightPriority !== leftPriority) return rightPriority - leftPriority;
    return right.updatedAt.localeCompare(left.updatedAt);
  });
  return fallback.slice(0, input.limit ?? 6);
};

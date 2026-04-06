/**
 * AI-powered memory relevance selection.
 *
 * 1:1 replicate of claude-code-source/src/memdir/findRelevantMemories.ts.
 *
 * Uses ModelClient.generate() instead of sideQuery.
 * Scans memory file headers and asks the model to select the most
 * relevant ones (up to 5) for a given query.
 */

import type { AgentMessage, ModelClient, ModelRequest } from "@renx/model";

import type { MemoryFileHeader } from "../memdir/scanner";
import { formatMemoryManifest } from "../memdir/entrypoint";

export type RelevantMemory = {
  path: string;
  mtimeMs: number;
};

export const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to Claude Code as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a JSON object with a "selected_memories" array containing filenames for the memories that will clearly be useful to Claude Code as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (Claude Code is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.
`;

/**
 * Find memory files relevant to a query by scanning headers and using
 * the model to select the most relevant ones (up to 5).
 *
 * 1:1 replicate of findRelevantMemories from claude-code-source.
 */
export async function findRelevantMemories(
  client: ModelClient,
  model: string,
  query: string,
  memoryDir: string,
  scanFn: (dir: string) => Promise<MemoryFileHeader[]>,
  signal: AbortSignal,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
): Promise<RelevantMemory[]> {
  const memories = (await scanFn(memoryDir)).filter((m) => !alreadySurfaced.has(m.filePath));
  if (memories.length === 0) return [];

  const selectedFilenames = await selectRelevantMemories(
    client,
    model,
    query,
    memories,
    signal,
    recentTools,
  );
  const byFilename = new Map(memories.map((m) => [m.filename, m]));
  const selected = selectedFilenames
    .map((filename) => byFilename.get(filename))
    .filter((m): m is MemoryFileHeader => m !== undefined);

  return selected.map((m) => ({ path: m.filePath, mtimeMs: m.mtimeMs }));
}

/**
 * Ask the model to select relevant memories from a manifest.
 *
 * 1:1 replicate of selectRelevantMemories from claude-code-source,
 * adapted to use ModelClient.generate() instead of sideQuery.
 */
export async function selectRelevantMemories(
  client: ModelClient,
  model: string,
  query: string,
  memories: MemoryFileHeader[],
  signal: AbortSignal,
  recentTools: readonly string[] = [],
): Promise<string[]> {
  const validFilenames = new Set(memories.map((m) => m.filename));
  const manifest = formatMemoryManifest(memories);

  const toolsSection =
    recentTools.length > 0 ? `\n\nRecently used tools: ${recentTools.join(", ")}` : "";

  try {
    const request: ModelRequest = {
      model,
      systemPrompt: SELECT_MEMORIES_SYSTEM_PROMPT,
      messages: [
        {
          id: "memory-ranking",
          role: "user" as const,
          content: `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}`,
          createdAt: new Date().toISOString(),
        },
      ],
      tools: [],
      maxTokens: 256,
      signal,
    };

    const result = await client.generate(request);

    if (result.type !== "final" || !result.output) {
      return [];
    }

    const parsed = safeParseSelection(result.output);
    return parsed.filter((f) => validFilenames.has(f));
  } catch {
    if (signal.aborted) return [];
    return [];
  }
}

/**
 * Parse the model's JSON response for selected_memories.
 */
function safeParseSelection(text: string): string[] {
  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.selected_memories)) {
      return parsed.selected_memories.filter((v: unknown) => typeof v === "string");
    }
  } catch {
    // Try to extract JSON from text
    const match = text.match(/\{[\s\S]*"selected_memories"[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed.selected_memories)) {
          return parsed.selected_memories.filter((v: unknown) => typeof v === "string");
        }
      } catch {
        // give up
      }
    }
  }
  return [];
}

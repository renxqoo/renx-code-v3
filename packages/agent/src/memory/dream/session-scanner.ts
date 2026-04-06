/**
 * Session scanner for dream consolidation.
 *
 * Scans transcript directories for JSONL session files touched since
 * a given timestamp. Matches listSessionsTouchedSince from
 * claude-code-source/src/services/autoDream/autoDream.ts.
 *
 * - Validates UUID filenames (excludes agent-*.jsonl and other non-UUID files)
 * - Supports excluding the current session
 * - Uses parallel stat for faster directory scanning
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** UUID v4 pattern for session filename validation. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a string is a well-formed UUID.
 */
function validateUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/**
 * Interface for scanning sessions in a transcript directory.
 */
export interface SessionScanner {
  listSessionsTouchedSince(
    sinceMs: number,
    transcriptDir: string,
    currentSessionId?: string,
  ): Promise<string[]>;
  countNewSessionsSince(
    sinceMs: number,
    transcriptDir: string,
    currentSessionId?: string,
  ): Promise<number>;
}

/**
 * Filesystem-backed session scanner. Reads a transcript directory,
 * filters .jsonl files by:
 *   1. Valid UUID filename stem (excludes agent-*.jsonl etc.)
 *   2. Excluding the current session
 *   3. mtime > sinceMs
 *
 * Uses parallel stat for faster scanning.
 */
export class FileSessionScanner implements SessionScanner {
  async listSessionsTouchedSince(
    sinceMs: number,
    transcriptDir: string,
    currentSessionId?: string,
  ): Promise<string[]> {
    const entries = await readdir(transcriptDir).catch(() => [] as string[]);

    // Filter to .jsonl files with valid UUID stems
    const candidates = entries.filter((entry) => {
      if (!entry.endsWith(".jsonl")) return false;
      const stem = entry.slice(0, -6); // strip .jsonl
      return validateUuid(stem);
    });

    if (candidates.length === 0) return [];

    // Parallel stat for mtime filtering
    const statResults = await Promise.all(
      candidates.map(async (entry) => {
        const fullPath = join(transcriptDir, entry);
        const s = await stat(fullPath).catch(() => null);
        return { entry, mtimeMs: s?.mtimeMs ?? 0 };
      }),
    );

    const results: string[] = [];
    for (const { entry, mtimeMs } of statResults) {
      if (mtimeMs <= sinceMs) continue;

      const sessionId = entry.slice(0, -6);

      // Exclude current session
      if (currentSessionId && sessionId === currentSessionId) continue;

      results.push(sessionId);
    }

    return results;
  }

  async countNewSessionsSince(
    sinceMs: number,
    transcriptDir: string,
    currentSessionId?: string,
  ): Promise<number> {
    const sessions = await this.listSessionsTouchedSince(sinceMs, transcriptDir, currentSessionId);
    return sessions.length;
  }
}

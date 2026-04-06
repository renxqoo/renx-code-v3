/**
 * Kairos daily-log mode.
 *
 * 1:1 replicate of the assistant-mode daily log pattern from
 * claude-code-source/src/memdir/memdir.ts (buildAssistantDailyLogPrompt).
 *
 * Append-only daily log files under {memoryDir}/logs/YYYY/MM/YYYY-MM-DD.md.
 * A separate dream process distills these into MEMORY.md and topic files.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Get the path for a daily log file.
 * Pattern: {memoryDir}/logs/YYYY/MM/YYYY-MM-DD.md
 */
export function getDailyLogPath(memoryDir: string, date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return join(memoryDir, "logs", String(year), month, `${year}-${month}-${day}.md`);
}

/**
 * Ensure the parent directory for a log file exists.
 */
export async function ensureLogDir(logPath: string): Promise<void> {
  const dir = dirname(logPath);
  await mkdir(dir, { recursive: true });
}

/**
 * Append a timestamped entry to the daily log.
 * Creates the file (and parent directories) on first write if needed.
 */
export async function appendToDailyLog(
  memoryDir: string,
  date: Date,
  entry: string,
): Promise<void> {
  const logPath = getDailyLogPath(memoryDir, date);
  await ensureLogDir(logPath);

  const timestamp = date.toISOString();
  const line = `- **${timestamp}**: ${entry}\n`;

  let existing = "";
  try {
    existing = await readFile(logPath, "utf8");
  } catch {
    // File doesn't exist yet
  }

  await writeFile(logPath, existing + line, "utf8");
}

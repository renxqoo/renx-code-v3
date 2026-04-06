import { resolve, sep } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { SessionMemoryRecord, SessionMemoryStore } from "@renx/agent";

/**
 * File-based SessionMemoryStore that persists session records as JSON files.
 *
 * Layout: <baseDir>/<runId>.json
 */
export class FileSessionMemoryStore implements SessionMemoryStore {
  constructor(private readonly baseDir: string) {}

  async load(runId: string): Promise<SessionMemoryRecord | null> {
    try {
      const raw = await readFile(this.path(runId), "utf-8");
      return JSON.parse(raw) as SessionMemoryRecord;
    } catch {
      return null;
    }
  }

  async save(runId: string, record: SessionMemoryRecord): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.path(runId), JSON.stringify(record, null, 2), "utf-8");
  }

  private path(runId: string): string {
    return resolve(this.baseDir, `${runId}.json`);
  }
}

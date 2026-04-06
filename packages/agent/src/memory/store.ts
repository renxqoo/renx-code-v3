import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { MemorySnapshot, MemoryStore } from "./types";
import { createMemorySnapshot } from "./snapshot";

export class InMemoryMemoryStore implements MemoryStore {
  private readonly snapshots = new Map<string, MemorySnapshot>();

  async load(runId: string): Promise<MemorySnapshot | null> {
    const snapshot = this.snapshots.get(runId);
    return snapshot ? createMemorySnapshot(snapshot) : null;
  }

  async save(runId: string, snapshot: MemorySnapshot): Promise<void> {
    this.snapshots.set(runId, createMemorySnapshot(snapshot));
  }
}

export class FileMemoryStore implements MemoryStore {
  constructor(private readonly baseDir: string) {}

  async load(runId: string): Promise<MemorySnapshot | null> {
    try {
      const raw = await readFile(this.getFilePath(runId), "utf8");
      return createMemorySnapshot(JSON.parse(raw) as MemorySnapshot);
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? (error as { code?: string }).code
          : undefined;
      if (code === "ENOENT") return null;
      throw error;
    }
  }

  async save(runId: string, snapshot: MemorySnapshot): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(
      this.getFilePath(runId),
      JSON.stringify(createMemorySnapshot(snapshot), null, 2),
      "utf8",
    );
  }

  private getFilePath(runId: string): string {
    return join(this.baseDir, `${runId}.json`);
  }
}

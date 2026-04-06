import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { SandboxSnapshotRecord, SandboxSnapshotStore } from "../types";

export class InMemorySandboxSnapshotStore implements SandboxSnapshotStore {
  private readonly records = new Map<string, SandboxSnapshotRecord>();

  async save(record: SandboxSnapshotRecord): Promise<void> {
    this.records.set(record.snapshotId, record);
  }

  async load(snapshotId: string): Promise<SandboxSnapshotRecord | undefined> {
    return this.records.get(snapshotId);
  }
}

export class FileSandboxSnapshotStore implements SandboxSnapshotStore {
  constructor(private readonly rootDir: string) {}

  async save(record: SandboxSnapshotRecord): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(
      join(this.rootDir, `${record.snapshotId}.json`),
      JSON.stringify(record, null, 2),
      "utf8",
    );
  }

  async load(snapshotId: string): Promise<SandboxSnapshotRecord | undefined> {
    try {
      const payload = await readFile(join(this.rootDir, `${snapshotId}.json`), "utf8");
      return JSON.parse(payload) as SandboxSnapshotRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }
}

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ManagedSandboxLeaseRecord, SandboxLeaseStore } from "./types";

const toRecordPath = (rootDir: string, runId: string): string =>
  join(rootDir, `${encodeURIComponent(runId)}.json`);

export class InMemorySandboxLeaseStore implements SandboxLeaseStore {
  private readonly records = new Map<string, ManagedSandboxLeaseRecord>();

  async save(record: ManagedSandboxLeaseRecord): Promise<void> {
    this.records.set(record.runId, { ...record });
  }

  async load(runId: string): Promise<ManagedSandboxLeaseRecord | undefined> {
    const record = this.records.get(runId);
    return record ? { ...record } : undefined;
  }

  async delete(runId: string): Promise<void> {
    this.records.delete(runId);
  }

  async list(): Promise<ManagedSandboxLeaseRecord[]> {
    return [...this.records.values()].map((record) => ({ ...record }));
  }
}

export class FileSandboxLeaseStore implements SandboxLeaseStore {
  constructor(private readonly rootDir: string) {}

  async save(record: ManagedSandboxLeaseRecord): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(
      toRecordPath(this.rootDir, record.runId),
      JSON.stringify(record, null, 2),
      "utf8",
    );
  }

  async load(runId: string): Promise<ManagedSandboxLeaseRecord | undefined> {
    try {
      const payload = await readFile(toRecordPath(this.rootDir, runId), "utf8");
      return JSON.parse(payload) as ManagedSandboxLeaseRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async delete(runId: string): Promise<void> {
    await rm(toRecordPath(this.rootDir, runId), { force: true });
  }

  async list(): Promise<ManagedSandboxLeaseRecord[]> {
    try {
      const entries = await readdir(this.rootDir);
      const records = await Promise.all(
        entries
          .filter((entry) => entry.endsWith(".json"))
          .map(async (entry) => {
            const payload = await readFile(join(this.rootDir, entry), "utf8");
            return JSON.parse(payload) as ManagedSandboxLeaseRecord;
          }),
      );
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}

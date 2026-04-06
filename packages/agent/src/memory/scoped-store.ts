import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createMemorySnapshot } from "./snapshot";
import type { MemoryScope, MemorySnapshot, ScopedMemoryStore } from "./types";

const sanitizeNamespace = (namespace: string): string => encodeURIComponent(namespace);

export class InMemoryScopedMemoryStore implements ScopedMemoryStore {
  private readonly snapshots = new Map<string, MemorySnapshot>();

  async load(scope: MemoryScope, namespace: string): Promise<MemorySnapshot | null> {
    const snapshot = this.snapshots.get(`${scope}:${namespace}`);
    return snapshot ? createMemorySnapshot(snapshot) : null;
  }

  async save(scope: MemoryScope, namespace: string, snapshot: MemorySnapshot): Promise<void> {
    this.snapshots.set(`${scope}:${namespace}`, createMemorySnapshot(snapshot));
  }
}

export class FileScopedMemoryStore implements ScopedMemoryStore {
  constructor(private readonly baseDir: string) {}

  async load(scope: MemoryScope, namespace: string): Promise<MemorySnapshot | null> {
    try {
      const raw = await readFile(this.getFilePath(scope, namespace), "utf8");
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

  async save(scope: MemoryScope, namespace: string, snapshot: MemorySnapshot): Promise<void> {
    const filePath = this.getFilePath(scope, namespace);
    await mkdir(join(this.baseDir, scope), { recursive: true });
    await writeFile(filePath, JSON.stringify(createMemorySnapshot(snapshot), null, 2), "utf8");
  }

  private getFilePath(scope: MemoryScope, namespace: string): string {
    return join(this.baseDir, scope, `${sanitizeNamespace(namespace)}.json`);
  }
}

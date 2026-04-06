import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createMemorySnapshot } from "./snapshot";
import { hasMeaningfulMemory } from "./policy";
import type {
  MemoryScope,
  MemorySnapshot,
  MemorySyncState,
  MemorySyncStateStore,
  ScopedMemoryStore,
} from "./types";

export interface MemorySnapshotSyncTarget {
  scope: MemoryScope;
  namespace: string;
}

export type MemorySnapshotSyncAction = "none" | "initialize" | "prompt-update";

const sanitizeNamespace = (namespace: string): string => encodeURIComponent(namespace);

export class InMemoryMemorySyncStateStore implements MemorySyncStateStore {
  private readonly states = new Map<string, MemorySyncState>();

  async load(scope: MemoryScope, namespace: string): Promise<MemorySyncState | null> {
    return this.states.get(`${scope}:${namespace}`) ?? null;
  }

  async save(scope: MemoryScope, namespace: string, state: MemorySyncState): Promise<void> {
    this.states.set(`${scope}:${namespace}`, state);
  }
}

export class FileMemorySyncStateStore implements MemorySyncStateStore {
  constructor(private readonly baseDir: string) {}

  async load(scope: MemoryScope, namespace: string): Promise<MemorySyncState | null> {
    try {
      const raw = await readFile(this.getFilePath(scope, namespace), "utf8");
      return JSON.parse(raw) as MemorySyncState;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? (error as { code?: string }).code
          : undefined;
      if (code === "ENOENT") return null;
      throw error;
    }
  }

  async save(scope: MemoryScope, namespace: string, state: MemorySyncState): Promise<void> {
    const filePath = this.getFilePath(scope, namespace);
    await mkdir(join(this.baseDir, scope), { recursive: true });
    await writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
  }

  private getFilePath(scope: MemoryScope, namespace: string): string {
    return join(this.baseDir, scope, `${sanitizeNamespace(namespace)}.json`);
  }
}

export class MemorySnapshotSyncService {
  constructor(
    private readonly scopedStore: ScopedMemoryStore,
    private readonly syncStateStore: MemorySyncStateStore,
  ) {}

  async checkForUpdate(input: {
    source: MemorySnapshotSyncTarget;
    target: MemorySnapshotSyncTarget;
  }): Promise<{ action: MemorySnapshotSyncAction; updatedAt?: string }> {
    const source = await this.scopedStore.load(input.source.scope, input.source.namespace);
    const sourceUpdatedAt = getMemorySnapshotUpdatedAt(source);
    if (!source || !sourceUpdatedAt) return { action: "none" };

    const target = await this.scopedStore.load(input.target.scope, input.target.namespace);
    if (!target || !hasMeaningfulMemory(target)) {
      return { action: "initialize", updatedAt: sourceUpdatedAt };
    }

    const syncState = await this.syncStateStore.load(input.target.scope, input.target.namespace);
    if (!syncState || new Date(sourceUpdatedAt) > new Date(syncState.syncedFrom)) {
      return { action: "prompt-update", updatedAt: sourceUpdatedAt };
    }

    return { action: "none", updatedAt: sourceUpdatedAt };
  }

  async initializeFromSnapshot(input: {
    source: MemorySnapshotSyncTarget;
    target: MemorySnapshotSyncTarget;
  }): Promise<void> {
    const snapshot = await this.getRequiredSourceSnapshot(input.source);
    const updatedAt = getMemorySnapshotUpdatedAt(snapshot);
    if (!updatedAt) return;
    await this.scopedStore.save(input.target.scope, input.target.namespace, snapshot);
    await this.syncStateStore.save(input.target.scope, input.target.namespace, {
      syncedFrom: updatedAt,
      updatedAt: new Date().toISOString(),
    });
  }

  async replaceFromSnapshot(input: {
    source: MemorySnapshotSyncTarget;
    target: MemorySnapshotSyncTarget;
  }): Promise<void> {
    await this.initializeFromSnapshot(input);
  }

  async markSnapshotSynced(input: {
    source: MemorySnapshotSyncTarget;
    target: MemorySnapshotSyncTarget;
  }): Promise<void> {
    const snapshot = await this.getRequiredSourceSnapshot(input.source);
    const updatedAt = getMemorySnapshotUpdatedAt(snapshot);
    if (!updatedAt) return;
    await this.syncStateStore.save(input.target.scope, input.target.namespace, {
      syncedFrom: updatedAt,
      updatedAt: new Date().toISOString(),
    });
  }

  private async getRequiredSourceSnapshot(
    source: MemorySnapshotSyncTarget,
  ): Promise<MemorySnapshot> {
    return createMemorySnapshot(
      (await this.scopedStore.load(source.scope, source.namespace)) ?? undefined,
    );
  }
}

export const getMemorySnapshotUpdatedAt = (
  snapshot: MemorySnapshot | null | undefined,
): string | undefined => {
  if (!snapshot) return undefined;
  const current = createMemorySnapshot(snapshot);
  const candidates = [
    ...current.working.recentFiles.map((entry) => entry.updatedAt),
    ...current.working.skills.map((entry) => entry.updatedAt),
    ...current.working.rules.map((entry) => entry.updatedAt),
    ...current.semantic.entries.map((entry) => entry.updatedAt),
    ...current.artifacts.preservedContextAssets.map((asset) => asset.updatedAt),
    ...(current.session?.lastExtractedAt ? [current.session.lastExtractedAt] : []),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  if (candidates.length === 0) return undefined;
  return [...candidates].sort((left, right) => right.localeCompare(left))[0];
};

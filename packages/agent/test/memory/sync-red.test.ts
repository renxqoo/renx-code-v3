import { describe, expect, it } from "vitest";

import {
  createMemorySnapshot,
  InMemoryMemorySyncStateStore,
  InMemoryScopedMemoryStore,
  MemorySnapshotSyncService,
} from "../../src/memory";

describe("memory snapshot sync", () => {
  it("initializes a target scope from a source snapshot and then reports stale updates", async () => {
    const scopedStore = new InMemoryScopedMemoryStore();
    const syncStateStore = new InMemoryMemorySyncStateStore();
    const sync = new MemorySnapshotSyncService(scopedStore, syncStateStore);

    await scopedStore.save(
      "project",
      "tenant-a/repo-a",
      createMemorySnapshot({
        semantic: {
          entries: [
            {
              id: "project:goal",
              content: "Original snapshot guidance.",
              updatedAt: "2026-04-05T01:00:00.000Z",
              scope: "project",
            },
          ],
        },
      }),
    );

    const initial = await sync.checkForUpdate({
      source: { scope: "project", namespace: "tenant-a/repo-a" },
      target: { scope: "local", namespace: "tenant-a/repo-a:machine-1" },
    });
    expect(initial.action).toBe("initialize");

    await sync.initializeFromSnapshot({
      source: { scope: "project", namespace: "tenant-a/repo-a" },
      target: { scope: "local", namespace: "tenant-a/repo-a:machine-1" },
    });

    const syncedTarget = createMemorySnapshot(
      (await scopedStore.load("local", "tenant-a/repo-a:machine-1")) ?? undefined,
    );
    expect(syncedTarget.semantic.entries[0]?.content).toContain("Original snapshot guidance.");

    await scopedStore.save(
      "project",
      "tenant-a/repo-a",
      createMemorySnapshot({
        semantic: {
          entries: [
            {
              id: "project:goal",
              content: "Updated snapshot guidance.",
              updatedAt: "2026-04-05T02:00:00.000Z",
              scope: "project",
            },
          ],
        },
      }),
    );

    const stale = await sync.checkForUpdate({
      source: { scope: "project", namespace: "tenant-a/repo-a" },
      target: { scope: "local", namespace: "tenant-a/repo-a:machine-1" },
    });
    expect(stale.action).toBe("prompt-update");

    await sync.markSnapshotSynced({
      source: { scope: "project", namespace: "tenant-a/repo-a" },
      target: { scope: "local", namespace: "tenant-a/repo-a:machine-1" },
    });

    const upToDate = await sync.checkForUpdate({
      source: { scope: "project", namespace: "tenant-a/repo-a" },
      target: { scope: "local", namespace: "tenant-a/repo-a:machine-1" },
    });
    expect(upToDate.action).toBe("none");
  });
});

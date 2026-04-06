import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createMemorySnapshot, FileMemoryStore, InMemoryMemoryStore } from "../../src/memory";

describe("memory store", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips layered snapshots through the in-memory store", async () => {
    const store = new InMemoryMemoryStore();
    const snapshot = createMemorySnapshot({
      working: {
        activePlan: "finish red tests first",
        recentFiles: [
          {
            path: "src/context/index.ts",
            content: "export class ContextOrchestrator {}",
            updatedAt: "2026-04-05T00:00:00.000Z",
          },
        ],
      },
      semantic: {
        entries: [
          {
            id: "project:constraints",
            content: "No compatibility code.",
            updatedAt: "2026-04-05T00:00:00.000Z",
          },
        ],
      },
    });

    await store.save("run_memory_1", snapshot);
    const loaded = await store.load("run_memory_1");

    expect(loaded).toEqual(snapshot);
  });

  it("stores each run as a dedicated snapshot file in a memory directory", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "renx-memory-store-"));
    tempDirs.push(tempDir);

    const store = new FileMemoryStore(tempDir);
    const snapshot = createMemorySnapshot({
      working: {
        activePlan: "persist full memory snapshots",
      },
      artifacts: {
        preservedContextAssets: [
          {
            id: "custom:rehydrate",
            kind: "custom",
            title: "rehydration asset",
            content: "reinject this after compact",
            updatedAt: "2026-04-05T00:00:00.000Z",
          },
        ],
      },
    });

    await store.save("run_memory_2", snapshot);
    const loaded = createMemorySnapshot((await store.load("run_memory_2")) ?? undefined);

    expect(loaded.working.activePlan).toBe("persist full memory snapshots");
    expect(loaded.artifacts.preservedContextAssets[0]?.content).toContain("reinject");
  });
});

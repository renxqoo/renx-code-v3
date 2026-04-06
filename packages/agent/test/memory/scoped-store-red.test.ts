import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createMemorySnapshot,
  FileScopedMemoryStore,
  InMemoryScopedMemoryStore,
} from "../../src/memory";

describe("scoped memory store", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores and loads snapshots by scope and namespace in memory", async () => {
    const store = new InMemoryScopedMemoryStore();
    const snapshot = createMemorySnapshot({
      semantic: {
        entries: [
          {
            id: "project:memory",
            content: "Persist project guidance.",
            updatedAt: "2026-04-05T00:00:00.000Z",
            scope: "project",
          },
        ],
      },
    });

    await store.save("project", "tenant-a/repo-a", snapshot);
    const loaded = await store.load("project", "tenant-a/repo-a");

    expect(loaded).toEqual(snapshot);
    expect(await store.load("project", "tenant-a/repo-b")).toBeNull();
  });

  it("stores each scope namespace in its own file hierarchy", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "renx-scoped-memory-"));
    tempDirs.push(tempDir);

    const store = new FileScopedMemoryStore(tempDir);
    const snapshot = createMemorySnapshot({
      working: {
        rules: [
          {
            name: "project-rule",
            content: "Run pnpm test before merge.",
            updatedAt: "2026-04-05T00:00:00.000Z",
            scope: "project",
          },
        ],
      },
    });

    await store.save("project", "tenant-a/repo-a", snapshot);
    const loaded = createMemorySnapshot(
      (await store.load("project", "tenant-a/repo-a")) ?? undefined,
    );

    expect(loaded.working.rules[0]?.name).toBe("project-rule");
  });
});

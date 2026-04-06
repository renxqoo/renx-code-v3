import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileMemoryDirStore } from "../../src/memory/memdir/store";
import type { MemorySnapshot } from "../../src/memory/types";
import { createMemorySnapshot } from "../../src/memory/snapshot";

describe("memdir file store", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads memory files from directory and returns MemorySnapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renx-memdir-store-"));
    tempDirs.push(dir);

    await writeFile(
      join(dir, "user_role.md"),
      `---
name: user_role
description: User is a backend engineer
type: user
---
User prefers Go and functional patterns.`,
    );
    await writeFile(
      join(dir, "feedback_testing.md"),
      `---
name: feedback_testing
description: Use real databases in tests
type: feedback
---
Integration tests must hit a real database, not mocks.
Why: prior incident where mock/prod divergence masked a broken migration.
How to apply: when writing integration tests, always connect to a real test database.`,
    );

    const store = new FileMemoryDirStore(dir);
    const snapshot = await store.load("project", "default");

    expect(snapshot).not.toBeNull();
    expect(snapshot!.semantic.entries.length).toBe(2);

    const roleEntry = snapshot!.semantic.entries.find((e) => e.title === "user_role");
    expect(roleEntry).toBeDefined();
    expect(roleEntry!.content).toContain("User prefers Go");
    expect(roleEntry!.type).toBe("user");
    expect(roleEntry!.description).toBe("User is a backend engineer");

    const feedbackEntry = snapshot!.semantic.entries.find((e) => e.title === "feedback_testing");
    expect(feedbackEntry).toBeDefined();
    expect(feedbackEntry!.type).toBe("feedback");
    expect(feedbackEntry!.why).toContain("prior incident");
    expect(feedbackEntry!.howToApply).toContain("real test database");
  });

  it("saves MemorySnapshot as individual .md files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renx-memdir-store-"));
    tempDirs.push(dir);

    const store = new FileMemoryDirStore(dir);
    const snapshot: MemorySnapshot = createMemorySnapshot({
      semantic: {
        entries: [
          {
            id: "entry-1",
            title: "test_feedback",
            description: "A test feedback",
            content: "Always run tests before committing.",
            type: "feedback",
            why: "Prevents broken builds.",
            howToApply: "Run `npm test` before git push.",
            tags: ["testing"],
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    });

    await store.save("project", "default", snapshot);

    // Read the written file and verify frontmatter
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(join(dir, "test_feedback.md"), "utf8");

    expect(content).toContain("name: test_feedback");
    expect(content).toContain("type: feedback");
    expect(content).toContain("Always run tests before committing.");
    expect(content).toContain("Prevents broken builds.");
  });

  it("round-trips correctly through load/save", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renx-memdir-store-"));
    tempDirs.push(dir);

    const store = new FileMemoryDirStore(dir);
    const original = createMemorySnapshot({
      semantic: {
        entries: [
          {
            id: "rt-1",
            title: "round_trip",
            description: "Round trip test",
            content: "Content that survives round-trip.",
            type: "project",
            updatedAt: "2026-04-05T00:00:00.000Z",
          },
        ],
      },
    });

    await store.save("project", "default", original);
    const loaded = await store.load("project", "default");

    expect(loaded).not.toBeNull();
    expect(loaded!.semantic.entries.length).toBe(1);
    expect(loaded!.semantic.entries[0]!.title).toBe("round_trip");
    expect(loaded!.semantic.entries[0]!.content).toBe("Content that survives round-trip.");
    expect(loaded!.semantic.entries[0]!.type).toBe("project");
  });

  it("returns null for non-existent directory", async () => {
    const store = new FileMemoryDirStore("/nonexistent/path");
    const result = await store.load("project", "default");
    expect(result).toBeNull();
  });

  it("skips MEMORY.md when loading", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renx-memdir-store-"));
    tempDirs.push(dir);

    await writeFile(join(dir, "MEMORY.md"), "- [Role](role.md) -- user role");
    await writeFile(
      join(dir, "role.md"),
      `---
name: role
description: User role
type: user
---
Content.`,
    );

    const store = new FileMemoryDirStore(dir);
    const snapshot = await store.load("project", "default");

    expect(snapshot!.semantic.entries.length).toBe(1);
    expect(snapshot!.semantic.entries[0]!.title).toBe("role");
  });

  it("ensureMemoryDirExists creates directory recursively", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renx-memdir-ensure-"));
    tempDirs.push(dir);
    const nestedDir = join(dir, "deep", "nested", "memory");

    const { ensureMemoryDirExists } = await import("../../src/memory/memdir/store");
    await ensureMemoryDirExists(nestedDir);

    const { stat } = await import("node:fs/promises");
    const s = await stat(nestedDir);
    expect(s.isDirectory()).toBe(true);
  });
});

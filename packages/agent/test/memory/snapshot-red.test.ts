import { describe, expect, it } from "vitest";

import { createMemorySnapshot, mergeMemorySnapshot, type MemorySnapshot } from "../../src/memory";

describe("memory snapshot", () => {
  it("merges working, semantic, and artifact layers by identity instead of replacing the whole snapshot", () => {
    const base = createMemorySnapshot({
      working: {
        recentFiles: [
          {
            path: "src/old.ts",
            content: "export const oldValue = 1;",
            updatedAt: "2026-04-05T00:00:00.000Z",
          },
        ],
        activePlan: "finish the memory migration",
        skills: [
          {
            name: "context-parity",
            path: ".agents/skills/context-parity/SKILL.md",
            content: "Preserve tool-call/tool-result invariants.",
            updatedAt: "2026-04-05T00:00:00.000Z",
          },
        ],
      },
      semantic: {
        entries: [
          {
            id: "pref:style",
            title: "Coding style",
            content: "Prefer concise TypeScript without compatibility shims.",
            updatedAt: "2026-04-05T00:00:00.000Z",
          },
        ],
      },
      artifacts: {
        preservedContextAssets: [
          {
            id: "custom:old",
            kind: "custom",
            title: "Old artifact",
            content: "preserve this artifact",
            updatedAt: "2026-04-05T00:00:00.000Z",
          },
        ],
      },
    });

    const merged = mergeMemorySnapshot(base, {
      working: {
        recentFiles: [
          {
            path: "src/old.ts",
            content: "export const oldValue = 2;",
            updatedAt: "2026-04-05T01:00:00.000Z",
          },
          {
            path: "src/new.ts",
            content: "export const newValue = 3;",
            updatedAt: "2026-04-05T01:00:00.000Z",
          },
        ],
        rules: [
          {
            name: "workspace-rules",
            path: ".claude/rules/workspace.md",
            content: "Always run pnpm test before finalizing.",
            updatedAt: "2026-04-05T01:00:00.000Z",
          },
        ],
      },
      semantic: {
        entries: [
          {
            id: "pref:style",
            title: "Coding style",
            content: "Prefer direct implementations with no compatibility layer.",
            updatedAt: "2026-04-05T01:00:00.000Z",
          },
          {
            id: "project:goal",
            title: "Current goal",
            content: "Ship a complete enterprise memory subsystem.",
            updatedAt: "2026-04-05T01:00:00.000Z",
          },
        ],
      },
      artifacts: {
        preservedContextAssets: [
          {
            id: "custom:old",
            kind: "custom",
            title: "Old artifact",
            content: "artifact updated",
            updatedAt: "2026-04-05T01:00:00.000Z",
          },
          {
            id: "custom:new",
            kind: "custom",
            title: "New artifact",
            content: "fresh artifact",
            updatedAt: "2026-04-05T01:00:00.000Z",
          },
        ],
      },
    });

    expect(merged.working.activePlan).toBe("finish the memory migration");
    expect(merged.working.recentFiles.map((entry) => entry.path)).toEqual([
      "src/new.ts",
      "src/old.ts",
    ]);
    expect(merged.working.recentFiles.find((entry) => entry.path === "src/old.ts")?.content).toBe(
      "export const oldValue = 2;",
    );
    expect(merged.working.skills).toHaveLength(1);
    expect(merged.working.rules[0]?.name).toBe("workspace-rules");
    expect(merged.semantic.entries.map((entry) => entry.id)).toEqual([
      "project:goal",
      "pref:style",
    ]);
    expect(merged.semantic.entries.find((entry) => entry.id === "pref:style")?.content).toContain(
      "no compatibility layer",
    );
    expect(merged.artifacts.preservedContextAssets.map((asset) => asset.id)).toEqual([
      "custom:new",
      "custom:old",
    ]);
  });

  it("creates a fully initialized empty layered snapshot", () => {
    const snapshot = createMemorySnapshot();

    expect(snapshot).toEqual<MemorySnapshot>({
      working: {
        recentFiles: [],
        skills: [],
        rules: [],
      },
      semantic: {
        entries: [],
      },
      artifacts: {
        preservedContextAssets: [],
      },
    });
  });
});

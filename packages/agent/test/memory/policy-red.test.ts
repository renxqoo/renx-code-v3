import { describe, expect, it } from "vitest";

import { applyMemoryPolicy, createMemorySnapshot } from "../../src/memory";

describe("memory policy", () => {
  it("trims layered memory to configured budgets while preserving newest and highest-priority entries", () => {
    const snapshot = createMemorySnapshot({
      working: {
        recentFiles: [
          {
            path: "src/newest.ts",
            content: "x".repeat(80),
            updatedAt: "2026-04-05T03:00:00.000Z",
          },
          {
            path: "src/middle.ts",
            content: "y".repeat(80),
            updatedAt: "2026-04-05T02:00:00.000Z",
          },
          {
            path: "src/oldest.ts",
            content: "z".repeat(80),
            updatedAt: "2026-04-05T01:00:00.000Z",
          },
        ],
        skills: [
          {
            name: "newest-skill",
            content: "a".repeat(80),
            updatedAt: "2026-04-05T03:00:00.000Z",
          },
          {
            name: "older-skill",
            content: "b".repeat(80),
            updatedAt: "2026-04-05T01:00:00.000Z",
          },
        ],
        rules: [
          {
            name: "newest-rule",
            content: "c".repeat(80),
            updatedAt: "2026-04-05T03:00:00.000Z",
          },
          {
            name: "older-rule",
            content: "d".repeat(80),
            updatedAt: "2026-04-05T01:00:00.000Z",
          },
        ],
      },
      semantic: {
        entries: [
          {
            id: "sem:new",
            title: "Newest",
            content: "n".repeat(120),
            updatedAt: "2026-04-05T03:00:00.000Z",
          },
          {
            id: "sem:old",
            title: "Old",
            content: "o".repeat(120),
            updatedAt: "2026-04-05T01:00:00.000Z",
          },
        ],
      },
      artifacts: {
        preservedContextAssets: [
          {
            id: "asset:high",
            kind: "custom",
            title: "High priority",
            content: "p".repeat(120),
            priority: 100,
            updatedAt: "2026-04-05T01:00:00.000Z",
          },
          {
            id: "asset:low",
            kind: "custom",
            title: "Low priority",
            content: "q".repeat(120),
            priority: 1,
            updatedAt: "2026-04-05T03:00:00.000Z",
          },
        ],
      },
    });

    const trimmed = applyMemoryPolicy(snapshot, {
      maxRecentFiles: 2,
      maxSkills: 1,
      maxRules: 1,
      maxSemanticEntries: 1,
      maxArtifacts: 1,
      maxContentChars: 32,
    });

    expect(trimmed.working.recentFiles.map((entry) => entry.path)).toEqual([
      "src/newest.ts",
      "src/middle.ts",
    ]);
    expect(trimmed.working.skills.map((entry) => entry.name)).toEqual(["newest-skill"]);
    expect(trimmed.working.rules.map((entry) => entry.name)).toEqual(["newest-rule"]);
    expect(trimmed.semantic.entries.map((entry) => entry.id)).toEqual(["sem:new"]);
    expect(trimmed.artifacts.preservedContextAssets.map((asset) => asset.id)).toEqual([
      "asset:high",
    ]);
    expect(trimmed.working.recentFiles[0]?.content?.length).toBeLessThanOrEqual(32);
    expect(trimmed.semantic.entries[0]?.content.length).toBeLessThanOrEqual(32);
    expect(trimmed.artifacts.preservedContextAssets[0]?.content.length).toBeLessThanOrEqual(32);
  });
});

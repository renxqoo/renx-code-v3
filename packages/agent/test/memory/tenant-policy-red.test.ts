import { describe, expect, it } from "vitest";

import type { MemorySubsystem } from "../../src/memory";
import { createMemorySnapshot, InMemoryMemoryStore, MemoryService } from "../../src/memory";
import { baseCtx } from "../helpers";

describe("memory tenant policy", () => {
  it("enforces tenant-level scope, taxonomy, and content restrictions during hydration", async () => {
    const store = new InMemoryMemoryStore();
    const subsystem: MemorySubsystem = {
      store,
      tenantPolicyResolver: async () => ({
        allowedScopes: ["project"],
        allowedTaxonomyTypes: ["project"],
        maxRecentFiles: 1,
        maxSemanticEntries: 1,
        maxContentChars: 80,
        redactSecrets: true,
        stripRecentFileContent: true,
        stripArtifactContent: true,
      }),
    };

    await store.save(
      "run-memory-policy",
      createMemorySnapshot({
        working: {
          recentFiles: [
            {
              path: "src/project.ts",
              content: "const apiKey = 'ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD';",
              updatedAt: "2026-04-05T01:00:00.000Z",
              scope: "project",
            },
            {
              path: "src/user.ts",
              content: "user-only context",
              updatedAt: "2026-04-05T01:10:00.000Z",
              scope: "user",
            },
          ],
        },
        semantic: {
          entries: [
            {
              id: "project:policy",
              type: "project",
              content: "Use token ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD only in the vault.",
              updatedAt: "2026-04-05T01:20:00.000Z",
              scope: "project",
            },
            {
              id: "reference:readme",
              type: "reference",
              content: "Repo structure summary.",
              updatedAt: "2026-04-05T01:30:00.000Z",
              scope: "project",
            },
          ],
        },
        artifacts: {
          preservedContextAssets: [
            {
              id: "asset:debug",
              kind: "custom",
              title: "Debug dump",
              content: "stack trace",
              updatedAt: "2026-04-05T01:40:00.000Z",
              scope: "project",
            },
          ],
        },
      }),
    );

    const service = new MemoryService(subsystem);
    const hydrated = await service.hydrateState(
      "run-memory-policy",
      baseCtx({ inputText: "continue" }).state,
      {
        runId: "run-memory-policy",
        tenantId: "tenant-a",
        userId: "user-a",
      },
    );
    const snapshot = createMemorySnapshot(hydrated.memory);

    expect(snapshot.working.recentFiles).toHaveLength(1);
    expect(snapshot.working.recentFiles[0]?.path).toBe("src/project.ts");
    expect(snapshot.working.recentFiles[0]?.content).toBeUndefined();
    expect(snapshot.semantic.entries).toHaveLength(1);
    expect(snapshot.semantic.entries[0]?.id).toBe("project:policy");
    expect(snapshot.semantic.entries[0]?.content).toContain("[REDACTED_SECRET]");
    expect(snapshot.artifacts.preservedContextAssets[0]?.content).toBe("");
  });
});

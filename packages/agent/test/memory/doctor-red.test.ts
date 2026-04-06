import { describe, expect, it } from "vitest";

import {
  createMemorySnapshot,
  inspectMemoryHealth,
  type MemoryTeamSyncState,
} from "../../src/memory";

describe("memory doctor", () => {
  it("flags prompt budget pressure, stale sync state, and secret-bearing shared memory", () => {
    const teamSyncState: MemoryTeamSyncState = {
      lastKnownChecksum: "checksum-1",
      serverChecksums: {},
      serverMaxEntries: null,
      lastSyncAt: "2026-04-05T00:00:00.000Z",
    };

    const report = inspectMemoryHealth(
      createMemorySnapshot({
        working: {
          recentFiles: [
            {
              path: "src/very-large.ts",
              content: "x".repeat(400),
              updatedAt: "2026-04-05T01:00:00.000Z",
              scope: "project",
            },
            {
              path: "src/another-large.ts",
              content: "y".repeat(400),
              updatedAt: "2026-04-05T01:10:00.000Z",
              scope: "project",
            },
          ],
        },
        semantic: {
          entries: [
            {
              id: "project:secret",
              type: "project",
              content: "Shared note with token ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD",
              updatedAt: "2026-04-05T01:20:00.000Z",
              scope: "project",
            },
            {
              id: "project:overflow",
              type: "project",
              content: "z".repeat(300),
              updatedAt: "2026-04-05T01:30:00.000Z",
              scope: "project",
            },
          ],
        },
      }),
      {
        promptTokenBudget: 60,
        staleSyncAfterHours: 1,
        now: "2026-04-05T12:00:00.000Z",
        teamSyncState,
        policy: {
          maxRecentFiles: 1,
          maxSemanticEntries: 1,
          maxContentChars: 128,
        },
      },
    );

    expect(report.ok).toBe(false);
    expect(report.warnings.map((warning) => warning.code)).toContain("prompt_budget_exceeded");
    expect(report.warnings.map((warning) => warning.code)).toContain("policy_pressure");
    expect(report.warnings.map((warning) => warning.code)).toContain("stale_shared_sync");
    expect(report.warnings.map((warning) => warning.code)).toContain(
      "shared_memory_secret_detected",
    );
  });
});

import { describe, expect, it } from "vitest";

import {
  createMemorySnapshot,
  recallMemoryEntries,
  MemoryService,
  type MemorySubsystem,
} from "../../src/memory";

describe("memory recall policy", () => {
  it("prioritizes relevant taxonomy memories for the current query", () => {
    const snapshot = createMemorySnapshot({
      semantic: {
        entries: [
          {
            id: "feedback:test-policy",
            type: "feedback",
            title: "Testing policy",
            description: "Real DB tests only",
            content: "Integration tests must hit the real database.",
            why: "Mocks hid a migration failure.",
            howToApply: "Do not mock the DB in this project.",
            updatedAt: "2026-04-05T03:00:00.000Z",
            scope: "project",
            tags: ["test", "database", "integration"],
          },
          {
            id: "reference:grafana",
            type: "reference",
            title: "Latency dashboard",
            description: "Grafana board",
            content: "grafana.internal/d/api-latency is the board oncall watches.",
            updatedAt: "2026-04-05T02:00:00.000Z",
            scope: "project",
            tags: ["grafana", "latency", "dashboard"],
          },
        ],
      },
    });

    const recalled = recallMemoryEntries(snapshot, {
      query: "Should these tests mock the database?",
      explicit: false,
      limit: 1,
    });

    expect(recalled.map((entry) => entry.id)).toEqual(["feedback:test-policy"]);
  });

  it("suppresses memory injection when the caller explicitly ignores memory", () => {
    const subsystem: MemorySubsystem = {
      store: {
        load: async () => null,
        save: async () => {},
      },
    };
    const service = new MemoryService(subsystem);
    const prompt = service.buildPromptMemory(
      createMemorySnapshot({
        working: {
          activePlan: "should not show up",
        },
        semantic: {
          entries: [
            {
              id: "project:test",
              type: "project",
              content: "should not show up",
              updatedAt: "2026-04-05T03:00:00.000Z",
            },
          ],
        },
      }),
      {
        ignoreMemory: true,
        query: "continue",
      },
    );

    expect(prompt).toBeNull();
  });
});

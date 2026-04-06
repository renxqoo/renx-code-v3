import { describe, expect, it } from "vitest";

import { InMemoryScopedMemoryStore, MemoryCommandService } from "../../src/memory";

describe("memory commands", () => {
  it("saves, lists, recalls, and deletes taxonomy-aware semantic memories in a scope", async () => {
    const store = new InMemoryScopedMemoryStore();
    const commands = new MemoryCommandService(store);

    const saved = await commands.save({
      scope: "project",
      namespace: "tenant-a/repo-a",
      entry: {
        id: "feedback:test-policy",
        type: "feedback",
        title: "Test policy",
        description: "Real DB tests only",
        content: "Integration tests must hit the real database.",
        why: "Mocks previously hid a migration failure.",
        howToApply: "Do not introduce db mocks in this repo.",
        updatedAt: "2026-04-05T03:00:00.000Z",
      },
    });

    expect(saved.type).toBe("feedback");

    const listed = await commands.list({
      scope: "project",
      namespace: "tenant-a/repo-a",
    });
    expect(listed.map((entry) => entry.id)).toEqual(["feedback:test-policy"]);

    const recalled = await commands.recall({
      scope: "project",
      namespace: "tenant-a/repo-a",
      query: "Should I mock the database in tests?",
      explicit: true,
    });
    expect(recalled[0]?.id).toBe("feedback:test-policy");

    await commands.delete({
      scope: "project",
      namespace: "tenant-a/repo-a",
      id: "feedback:test-policy",
    });

    const afterDelete = await commands.list({
      scope: "project",
      namespace: "tenant-a/repo-a",
    });
    expect(afterDelete).toEqual([]);
  });

  it("rejects memories that only restate derivable codebase state", async () => {
    const store = new InMemoryScopedMemoryStore();
    const commands = new MemoryCommandService(store);

    await expect(
      commands.save({
        scope: "project",
        namespace: "tenant-a/repo-a",
        entry: {
          id: "project:derivable",
          type: "project",
          title: "File path note",
          description: "Only file structure",
          content: "The repo has a src/context/index.ts file and uses TypeScript.",
          updatedAt: "2026-04-05T03:00:00.000Z",
        },
      }),
    ).rejects.toThrow("derivable");
  });
});

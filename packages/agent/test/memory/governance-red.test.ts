import { describe, expect, it } from "vitest";

import { applyMemoryGovernance, createMemorySnapshot } from "../../src/memory";

describe("memory governance", () => {
  it("drops expired semantic memories and redacts sensitive content", () => {
    const governed = applyMemoryGovernance(
      createMemorySnapshot({
        semantic: {
          entries: [
            {
              id: "project:expired",
              type: "project",
              content: "Old rollout note.",
              updatedAt: "2025-01-01T00:00:00.000Z",
            },
            {
              id: "feedback:active",
              type: "feedback",
              content: "Contact ops@example.com and use sk-secret-123 for staging.",
              why: "ops@example.com owns staging validation.",
              howToApply: "Never expose sk-secret-123 in prompts.",
              updatedAt: "2026-04-05T00:00:00.000Z",
            },
          ],
        },
      }),
      {
        maxEntryAgeDays: 30,
        redactEmails: true,
        redactSecrets: true,
      },
      {
        now: "2026-04-05T12:00:00.000Z",
      },
    );

    expect(governed.semantic.entries.map((entry) => entry.id)).toEqual(["feedback:active"]);
    expect(governed.semantic.entries[0]?.content).toContain("[REDACTED_EMAIL]");
    expect(governed.semantic.entries[0]?.content).toContain("[REDACTED_SECRET]");
    expect(governed.semantic.entries[0]?.why).toContain("[REDACTED_EMAIL]");
    expect(governed.semantic.entries[0]?.howToApply).toContain("[REDACTED_SECRET]");
  });
});

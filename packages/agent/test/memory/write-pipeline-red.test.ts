import { describe, expect, it } from "vitest";

import { createMemorySnapshot, MemoryWritePipeline } from "../../src/memory";

describe("memory write pipeline", () => {
  it("builds a policy-trimmed run snapshot and scope-specific projections from one source snapshot", () => {
    const pipeline = new MemoryWritePipeline({
      maxSemanticEntries: 4,
      maxContentChars: 48,
    });
    const source = createMemorySnapshot({
      working: {
        activePlan:
          "Keep the run snapshot rich while persisting project guidance to a scoped store.",
        rules: [
          {
            name: "project-rule",
            content:
              "Always write red tests before implementation and keep the architecture minimal.",
            updatedAt: "2026-04-05T03:00:00.000Z",
            scope: "project",
          },
        ],
      },
      semantic: {
        entries: [
          {
            id: "project:goal",
            content: "Persist project knowledge for the whole team.",
            updatedAt: "2026-04-05T03:00:00.000Z",
            scope: "project",
          },
          {
            id: "user:style",
            content: "Keep explanations concise for this user.",
            updatedAt: "2026-04-05T02:00:00.000Z",
            scope: "user",
          },
        ],
      },
    });

    const plan = pipeline.plan(source, {
      user: "tenant-a:user-a",
      project: "tenant-a/repo-a",
    });

    expect(plan.runSnapshot.working.activePlan).toContain("Keep the run snapshot rich");
    expect(plan.scopedSnapshots.project?.semantic.entries.map((entry) => entry.id)).toEqual([
      "project:goal",
    ]);
    expect(plan.scopedSnapshots.project?.working.rules.map((entry) => entry.name)).toEqual([
      "project-rule",
    ]);
    expect(plan.scopedSnapshots.user?.semantic.entries.map((entry) => entry.id)).toEqual([
      "user:style",
    ]);
    expect(plan.scopedSnapshots.project?.working.rules[0]?.content?.length).toBeLessThanOrEqual(48);
  });
});

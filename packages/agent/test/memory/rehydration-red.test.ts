import { describe, expect, it } from "vitest";

import { buildRehydrationHints } from "../../src/context/rehydration";
import { createMemorySnapshot } from "../../src/memory";

describe("memory rehydration", () => {
  it("reinjects recent file content, active plan, active skills, rules, and preserved artifacts after compaction", () => {
    const hints = buildRehydrationHints({
      memory: createMemorySnapshot({
        working: {
          recentFiles: [
            {
              path: "src/context/index.ts",
              content: "export class ContextOrchestrator {}",
              updatedAt: "2026-04-05T01:00:00.000Z",
            },
          ],
          activePlan: "finish the memory subsystem before adding platform extras",
          skills: [
            {
              name: "context-parity",
              path: ".agents/skills/context-parity/SKILL.md",
              content: "Preserve tool pairs and thinking chunk continuity.",
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
        artifacts: {
          preservedContextAssets: [
            {
              id: "custom:1",
              kind: "custom",
              title: "Manual note",
              content: "Carry this debugging breadcrumb across compaction.",
              priority: 120,
              updatedAt: "2026-04-05T01:00:00.000Z",
            },
          ],
        },
      }),
      rehydrationTokenBudget: 500,
      recentFileBudgetTokens: 200,
      skillsRehydrateBudgetTokens: 120,
    });

    const recentFilesHint = hints.find(
      (hint) => hint.metadata?.["rehydrationKind"] === "recent_files",
    );
    const planHint = hints.find((hint) => hint.metadata?.["rehydrationKind"] === "plan");
    const skillsHint = hints.find((hint) => hint.metadata?.["rehydrationKind"] === "skills");
    const rulesHint = hints.find((hint) => hint.metadata?.["rehydrationKind"] === "rules");
    const customHint = hints.find((hint) => hint.metadata?.["rehydrationKind"] === "custom");

    expect(recentFilesHint?.content).toContain("src/context/index.ts");
    expect(recentFilesHint?.content).toContain("ContextOrchestrator");
    expect(planHint?.content).toContain("finish the memory subsystem");
    expect(skillsHint?.content).toContain("context-parity");
    expect(skillsHint?.content).toContain("Preserve tool pairs");
    expect(rulesHint?.content).toContain("workspace-rules");
    expect(rulesHint?.content).toContain("Always run pnpm test");
    expect(customHint?.content).toContain("Manual note");
    expect(customHint?.content).toContain("debugging breadcrumb");
  });
});

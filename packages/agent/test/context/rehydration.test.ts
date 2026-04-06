import { describe, expect, it } from "vitest";

import { buildRehydrationHints } from "../../src/context/rehydration";
import { createMemorySnapshot } from "../../src/memory";

describe("buildRehydrationHints", () => {
  it("emits structured rehydration messages per category", () => {
    const hints = buildRehydrationHints({
      memory: createMemorySnapshot({
        working: {
          recentFiles: [
            { path: "a.ts", updatedAt: "2026-04-05T00:00:00.000Z" },
            { path: "b.ts", updatedAt: "2026-04-05T00:00:00.000Z" },
          ],
          activePlan: {
            step: "keep-compaction-context",
          },
          skills: [
            { name: "skill-a", updatedAt: "2026-04-05T00:00:00.000Z" },
            { name: "skill-b", updatedAt: "2026-04-05T00:00:00.000Z" },
          ],
          hooks: {
            sessionStart: "restore CLAUDE.md-like context",
          },
          mcpInstructions: {
            serverA: ["do-x", "do-y"],
          },
        },
      }),
      rehydrationTokenBudget: 300,
      recentFileBudgetTokens: 80,
      skillsRehydrateBudgetTokens: 80,
      roundIndex: 9,
    });

    expect(hints.length).toBeGreaterThanOrEqual(4);
    expect(hints.some((hint) => hint.id.startsWith("rehydration_recent_files_"))).toBe(true);
    expect(hints.some((hint) => hint.id.startsWith("rehydration_plan_"))).toBe(true);
    expect(hints.some((hint) => hint.id.startsWith("rehydration_skills_"))).toBe(true);
    expect(hints.some((hint) => hint.id.startsWith("rehydration_hooks_"))).toBe(true);
    expect(hints.some((hint) => hint.id.startsWith("rehydration_mcp_"))).toBe(true);
  });

  it("respects rehydration budgets for files and skills", () => {
    const hints = buildRehydrationHints({
      memory: createMemorySnapshot({
        working: {
          recentFiles: Array.from({ length: 10 }, (_, i) => ({
            path: `a/very/long/path/file-${i}.ts`,
            updatedAt: "2026-04-05T00:00:00.000Z",
          })),
          skills: Array.from({ length: 20 }, (_, i) => ({
            name: `skill-${i}-with-long-detail`,
            updatedAt: "2026-04-05T00:00:00.000Z",
          })),
          activePlan: "plan-step-1",
        },
      }),
      rehydrationTokenBudget: 40,
      recentFileBudgetTokens: 10,
      skillsRehydrateBudgetTokens: 10,
    });

    expect(hints.length).toBeGreaterThanOrEqual(1);
    const content = hints.map((hint) => hint.content).join("\n");
    expect(content).toContain("[Post Compact Rehydration");
    expect(content).toContain("budget:40");
  });

  it("uses a stable id for both id and messageId", () => {
    const hints = buildRehydrationHints({
      memory: createMemorySnapshot({
        working: {
          activePlan: "plan-step-1",
        },
      }),
      rehydrationTokenBudget: 40,
      recentFileBudgetTokens: 10,
      skillsRehydrateBudgetTokens: 10,
    });

    expect(hints.length).toBeGreaterThanOrEqual(1);
    for (const hint of hints) {
      expect(hint.id).toBe(hint.messageId);
    }
  });

  it("drops only oversized categories instead of dropping the whole rehydration payload", () => {
    const hints = buildRehydrationHints({
      memory: createMemorySnapshot({
        working: {
          recentFiles: Array.from({ length: 50 }, (_, i) => ({
            path: `very/long/path/to/file-${i}.ts`,
            updatedAt: "2026-04-05T00:00:00.000Z",
          })),
          activePlan: "keep this even when recent files overflow",
        },
      }),
      rehydrationTokenBudget: 30,
      recentFileBudgetTokens: 5,
      skillsRehydrateBudgetTokens: 5,
    });

    expect(hints.some((hint) => hint.id.startsWith("rehydration_recent_files_"))).toBe(false);
    expect(hints.some((hint) => hint.id.startsWith("rehydration_plan_"))).toBe(true);
  });

  it("rehydrates recent files with inline content snippets when detailed file data is available", () => {
    const hints = buildRehydrationHints({
      memory: createMemorySnapshot({
        working: {
          recentFiles: [
            {
              path: "src/context/index.ts",
              content: "export class ContextOrchestrator { prepare() { return 'ok'; } }",
              updatedAt: "2026-04-05T00:00:00.000Z",
            },
          ],
        },
      }),
      rehydrationTokenBudget: 200,
      recentFileBudgetTokens: 120,
      skillsRehydrateBudgetTokens: 40,
    });

    const recentFilesHint = hints.find((hint) => hint.id.startsWith("rehydration_recent_files_"));
    expect(recentFilesHint?.content).toContain("src/context/index.ts");
    expect(recentFilesHint?.content).toContain("ContextOrchestrator");
  });

  it("rehydrates invoked skills with truncated content instead of only names when detailed skill data is available", () => {
    const hints = buildRehydrationHints({
      memory: createMemorySnapshot({
        working: {
          skills: [
            {
              name: "context-parity",
              path: ".agents/skills/context-parity/SKILL.md",
              content:
                "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10",
              updatedAt: "2026-04-05T00:00:00.000Z",
            },
          ],
        },
      }),
      rehydrationTokenBudget: 120,
      recentFileBudgetTokens: 20,
      skillsRehydrateBudgetTokens: 60,
    });

    const skillHint = hints.find((hint) => hint.id.startsWith("rehydration_skills_"));
    expect(skillHint?.content).toContain("context-parity");
    expect(skillHint?.content).toContain("Line 1");
  });

  it("truncates oversized detailed file payloads instead of dropping the entire recent-files category", () => {
    const hints = buildRehydrationHints({
      memory: createMemorySnapshot({
        working: {
          recentFiles: [
            {
              path: "src/huge.ts",
              content: "a".repeat(2_000),
              updatedAt: "2026-04-05T00:00:00.000Z",
            },
          ],
        },
      }),
      rehydrationTokenBudget: 120,
      recentFileBudgetTokens: 30,
      skillsRehydrateBudgetTokens: 20,
    });

    const recentFilesHint = hints.find((hint) => hint.id.startsWith("rehydration_recent_files_"));
    expect(recentFilesHint).toBeDefined();
    expect(recentFilesHint?.content).toContain("src/huge.ts");
  });

  it("rehydrates active rules separately from skills when rule content is available", () => {
    const hints = buildRehydrationHints({
      memory: createMemorySnapshot({
        working: {
          rules: [
            {
              name: "workspace-rules",
              path: ".claude/rules/workspace.md",
              content: "Always run tests after changing context compaction code.",
              updatedAt: "2026-04-05T00:00:00.000Z",
            },
          ],
        },
      }),
      rehydrationTokenBudget: 120,
      recentFileBudgetTokens: 20,
      skillsRehydrateBudgetTokens: 30,
    });

    const rulesHint = hints.find((hint) => hint.id.startsWith("rehydration_rules_"));
    expect(rulesHint?.content).toContain("workspace-rules");
    expect(rulesHint?.content).toContain("Always run tests");
  });
});

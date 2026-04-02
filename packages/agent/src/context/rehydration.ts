import type { RunMessage } from "../message/types";

const toTokenEstimate = (value: string): number => Math.ceil(value.length / 4);

export const buildRehydrationHints = (input: {
  memory: Record<string, unknown>;
  rehydrationTokenBudget: number;
  recentFileBudgetTokens: number;
  skillsRehydrateBudgetTokens: number;
}): RunMessage[] => {
  const hints: string[] = [];
  const pick = (key: string) => input.memory[key];
  let remaining = input.rehydrationTokenBudget;

  const pushHint = (hint: string, budgetLimit?: number): void => {
    const estimate = toTokenEstimate(hint);
    const allowed = budgetLimit ?? remaining;
    if (estimate > remaining || estimate > allowed) return;
    hints.push(hint);
    remaining -= estimate;
  };

  const recentFilesRaw = pick("recentFiles");
  if (recentFilesRaw) {
    const serialized = `recentFiles=${JSON.stringify(recentFilesRaw)}`;
    pushHint(serialized, input.recentFileBudgetTokens);
  }

  if (pick("activePlan")) pushHint(`activePlan=${JSON.stringify(pick("activePlan"))}`);
  if (pick("skills")) {
    pushHint(`skills=${JSON.stringify(pick("skills"))}`, input.skillsRehydrateBudgetTokens);
  }
  if (pick("hooks")) pushHint(`hooks=${JSON.stringify(pick("hooks"))}`);
  if (pick("mcpInstructions"))
    pushHint(`mcpInstructions=${JSON.stringify(pick("mcpInstructions"))}`);

  if (hints.length === 0) return [];

  return [
    {
      id: `rehydration_${Date.now()}`,
      messageId: `rehydration_${Date.now()}`,
      role: "system",
      source: "framework",
      createdAt: new Date().toISOString(),
      content: `[Post Compact Rehydration][budget:${input.rehydrationTokenBudget}]\n${hints.join("\n")}`,
    },
  ];
};

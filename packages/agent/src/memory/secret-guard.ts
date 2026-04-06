import { createMemorySnapshot } from "./snapshot";
import type { MemorySnapshot } from "./types";

export interface MemorySecretMatch {
  ruleId: string;
  label: string;
}

export interface SharedMemorySecretIssue {
  key: string;
  matches: MemorySecretMatch[];
}

export interface SharedMemorySecretReport {
  hasSecrets: boolean;
  issues: SharedMemorySecretIssue[];
}

type SecretRule = {
  id: string;
  label: string;
  pattern: RegExp;
};

const SECRET_RULES: SecretRule[] = [
  {
    id: "github-pat",
    label: "GitHub PAT",
    pattern: /\bghp_[0-9a-zA-Z]{30,}\b/g,
  },
  {
    id: "github-fine-grained-pat",
    label: "GitHub Fine-grained PAT",
    pattern: /\bgithub_pat_[0-9a-zA-Z_]{60,120}\b/g,
  },
  {
    id: "openai-api-key",
    label: "OpenAI API Key",
    pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "slack-bot-token",
    label: "Slack Bot Token",
    pattern: /\bxoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*\b/g,
  },
];

const collectSharedEntries = (
  snapshot: MemorySnapshot | undefined,
): Array<{ key: string; content: string }> => {
  const current = createMemorySnapshot(snapshot);
  const entries: Array<{ key: string; content: string }> = [];

  for (const entry of current.working.recentFiles) {
    if (!entry.content) continue;
    entries.push({ key: `working/recent-file:${entry.path}`, content: entry.content });
  }
  for (const entry of current.working.skills) {
    if (!entry.content) continue;
    entries.push({ key: `working/skill:${entry.path ?? entry.name}`, content: entry.content });
  }
  for (const entry of current.working.rules) {
    if (!entry.content) continue;
    entries.push({ key: `working/rule:${entry.path ?? entry.name}`, content: entry.content });
  }
  if (typeof current.working.activePlan === "string" && current.working.activePlan.length > 0) {
    entries.push({ key: "working/active-plan", content: current.working.activePlan });
  }
  if (current.working.hooks !== undefined) {
    entries.push({ key: "working/hooks", content: JSON.stringify(current.working.hooks) });
  }
  if (current.working.mcpInstructions !== undefined) {
    entries.push({
      key: "working/mcp-instructions",
      content: JSON.stringify(current.working.mcpInstructions),
    });
  }
  for (const entry of current.semantic.entries) {
    entries.push({ key: `semantic/${entry.id}`, content: entry.content });
  }
  for (const asset of current.artifacts.preservedContextAssets) {
    entries.push({ key: `artifact/${asset.id}`, content: asset.content });
  }

  return entries;
};

export const scanMemorySecrets = (content: string): MemorySecretMatch[] => {
  const matches: MemorySecretMatch[] = [];
  for (const rule of SECRET_RULES) {
    if (rule.pattern.test(content)) {
      matches.push({ ruleId: rule.id, label: rule.label });
    }
    rule.pattern.lastIndex = 0;
  }
  return matches;
};

export const checkSharedMemorySnapshotForSecrets = (
  snapshot: MemorySnapshot | undefined,
): SharedMemorySecretReport => {
  const issues = collectSharedEntries(snapshot)
    .map(({ key, content }) => ({
      key,
      matches: scanMemorySecrets(content),
    }))
    .filter((issue) => issue.matches.length > 0);

  return {
    hasSecrets: issues.length > 0,
    issues,
  };
};

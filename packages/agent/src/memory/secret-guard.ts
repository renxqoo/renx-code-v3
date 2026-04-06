/**
 * Shared memory snapshot secret scanning.
 *
 * Uses the full 37-rule gitleaks-compatible scanner from ./secret-scanner
 * to scan all memory snapshot entries for credential patterns.
 *
 * Reports which entries are unsafe to sync.
 */

import { createMemorySnapshot } from "./snapshot";
import type { MemorySnapshot } from "./types";
import { scanForSecrets, type SecretMatch } from "./secret-scanner";

export type { SecretMatch } from "./secret-scanner";

export interface SharedMemorySecretIssue {
  key: string;
  matches: SecretMatch[];
}

export interface SharedMemorySecretReport {
  hasSecrets: boolean;
  issues: SharedMemorySecretIssue[];
}

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

export const scanMemorySecrets = (content: string): SecretMatch[] => {
  return scanForSecrets(content);
};

export const checkSharedMemorySnapshotForSecrets = (
  snapshot: MemorySnapshot | undefined,
): SharedMemorySecretReport => {
  const issues = collectSharedEntries(snapshot)
    .map(({ key, content }) => ({
      key,
      matches: scanForSecrets(content),
    }))
    .filter((issue) => issue.matches.length > 0);

  return {
    hasSecrets: issues.length > 0,
    issues,
  };
};

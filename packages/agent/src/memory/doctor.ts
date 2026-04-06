import { checkSharedMemorySnapshotForSecrets } from "./secret-guard";
import { createMemorySnapshot } from "./snapshot";
import type { MemoryPolicy, MemorySnapshot } from "./types";
import type { MemoryTeamSyncState } from "./team-sync";

export interface MemoryHealthWarning {
  code:
    | "prompt_budget_exceeded"
    | "policy_pressure"
    | "stale_shared_sync"
    | "shared_memory_secret_detected";
  severity: "warning" | "error";
  message: string;
  details?: Record<string, unknown>;
}

export interface MemoryHealthReport {
  ok: boolean;
  warnings: MemoryHealthWarning[];
  stats: {
    estimatedPromptTokens: number;
    recentFileCount: number;
    semanticEntryCount: number;
    artifactCount: number;
    secretIssueCount: number;
  };
}

export interface InspectMemoryHealthOptions {
  promptTokenBudget?: number;
  staleSyncAfterHours?: number;
  now?: string;
  teamSyncState?: MemoryTeamSyncState;
  policy?: Partial<MemoryPolicy>;
}

const estimateTokens = (value: string): number => Math.max(1, Math.ceil(value.length / 4));

const toPromptText = (snapshot: MemorySnapshot | undefined): string => {
  const current = createMemorySnapshot(snapshot);
  return [
    current.working.recentFiles.map((entry) => `${entry.path}\n${entry.content ?? ""}`).join("\n"),
    current.working.skills.map((entry) => `${entry.name}\n${entry.content ?? ""}`).join("\n"),
    current.working.rules.map((entry) => `${entry.name}\n${entry.content ?? ""}`).join("\n"),
    typeof current.working.activePlan === "string"
      ? current.working.activePlan
      : JSON.stringify(current.working.activePlan ?? ""),
    current.semantic.entries.map((entry) => `${entry.id}\n${entry.content}`).join("\n"),
    current.artifacts.preservedContextAssets
      .map((asset) => `${asset.id}\n${asset.content}`)
      .join("\n"),
  ].join("\n");
};

const hasPolicyPressure = (
  snapshot: MemorySnapshot | undefined,
  policy: Partial<MemoryPolicy> | undefined,
): Record<string, unknown> | null => {
  if (!policy) return null;
  const current = createMemorySnapshot(snapshot);
  const breaches: Record<string, unknown> = {};

  if (
    policy.maxRecentFiles !== undefined &&
    current.working.recentFiles.length > policy.maxRecentFiles
  ) {
    breaches["recentFiles"] = {
      current: current.working.recentFiles.length,
      max: policy.maxRecentFiles,
    };
  }
  if (
    policy.maxSemanticEntries !== undefined &&
    current.semantic.entries.length > policy.maxSemanticEntries
  ) {
    breaches["semanticEntries"] = {
      current: current.semantic.entries.length,
      max: policy.maxSemanticEntries,
    };
  }
  if (policy.maxContentChars !== undefined) {
    const tooLarge = [
      ...current.working.recentFiles.map((entry) => entry.content ?? ""),
      ...current.semantic.entries.map((entry) => entry.content),
    ].some((content) => content.length > policy.maxContentChars!);
    if (tooLarge) {
      breaches["contentChars"] = { max: policy.maxContentChars };
    }
  }

  return Object.keys(breaches).length > 0 ? breaches : null;
};

export const inspectMemoryHealth = (
  snapshot: MemorySnapshot | undefined,
  options?: InspectMemoryHealthOptions,
): MemoryHealthReport => {
  const current = createMemorySnapshot(snapshot);
  const warnings: MemoryHealthWarning[] = [];
  const estimatedPromptTokens = estimateTokens(toPromptText(current));
  const promptTokenBudget = options?.promptTokenBudget;

  if (promptTokenBudget !== undefined && estimatedPromptTokens > promptTokenBudget) {
    warnings.push({
      code: "prompt_budget_exceeded",
      severity: "warning",
      message: `Estimated prompt memory exceeds budget (${estimatedPromptTokens} > ${promptTokenBudget}).`,
      details: { estimatedPromptTokens, promptTokenBudget },
    });
  }

  const policyPressure = hasPolicyPressure(current, options?.policy);
  if (policyPressure) {
    warnings.push({
      code: "policy_pressure",
      severity: "warning",
      message: "Memory snapshot exceeds configured tenant or runtime policy limits.",
      details: policyPressure,
    });
  }

  const secretReport = checkSharedMemorySnapshotForSecrets(current);
  if (secretReport.hasSecrets) {
    warnings.push({
      code: "shared_memory_secret_detected",
      severity: "error",
      message: "Shared memory contains secret-like content that should not be synchronized.",
      details: { issueCount: secretReport.issues.length, issues: secretReport.issues },
    });
  }

  const staleSyncAfterHours = options?.staleSyncAfterHours ?? 24;
  const lastSyncAt = options?.teamSyncState?.lastSyncAt;
  if (lastSyncAt) {
    const now = Date.parse(options?.now ?? new Date().toISOString());
    const lastSync = Date.parse(lastSyncAt);
    if (Number.isFinite(now) && Number.isFinite(lastSync)) {
      const staleHours = (now - lastSync) / 3_600_000;
      if (staleHours > staleSyncAfterHours) {
        warnings.push({
          code: "stale_shared_sync",
          severity: "warning",
          message: `Shared memory sync is stale (${staleHours.toFixed(1)}h since last sync).`,
          details: { lastSyncAt, staleHours, staleSyncAfterHours },
        });
      }
    }
  }

  return {
    ok: warnings.length === 0,
    warnings,
    stats: {
      estimatedPromptTokens,
      recentFileCount: current.working.recentFiles.length,
      semanticEntryCount: current.semantic.entries.length,
      artifactCount: current.artifacts.preservedContextAssets.length,
      secretIssueCount: secretReport.issues.length,
    },
  };
};

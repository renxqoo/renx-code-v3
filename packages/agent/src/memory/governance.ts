import { createMemorySnapshot } from "./snapshot";
import type {
  MemoryGovernanceConfig,
  MemorySemanticEntry,
  MemorySnapshot,
  ResolvedMemorySnapshot,
} from "./types";

export const DEFAULT_MEMORY_GOVERNANCE_CONFIG: MemoryGovernanceConfig = {
  maxEntryAgeDays: 180,
  redactEmails: true,
  redactSecrets: true,
};

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SECRET_PATTERN =
  /\b(?:sk|rk|pk|api|token)[-_][A-Za-z0-9_-]{6,}\b|\bghp_[0-9A-Za-z]{30,}\b|\bgithub_pat_[0-9A-Za-z_]{60,120}\b|\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}\b/gi;

const daysBetween = (older: string, newer: string): number => {
  const olderMs = Date.parse(older);
  const newerMs = Date.parse(newer);
  if (!Number.isFinite(olderMs) || !Number.isFinite(newerMs)) return 0;
  return Math.floor((newerMs - olderMs) / 86_400_000);
};

const redact = (value: string | undefined, config: MemoryGovernanceConfig): string | undefined => {
  if (value === undefined) return undefined;
  let next = value;
  if (config.redactEmails) {
    next = next.replace(EMAIL_PATTERN, "[REDACTED_EMAIL]");
  }
  if (config.redactSecrets) {
    next = next.replace(SECRET_PATTERN, "[REDACTED_SECRET]");
  }
  return next;
};

const governSemanticEntry = (
  entry: MemorySemanticEntry,
  config: MemoryGovernanceConfig,
): MemorySemanticEntry => {
  const title = redact(entry.title, config);
  const description = redact(entry.description, config);
  const why = redact(entry.why, config);
  const howToApply = redact(entry.howToApply, config);
  return {
    ...entry,
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    content: redact(entry.content, config) ?? "",
    ...(why !== undefined ? { why } : {}),
    ...(howToApply !== undefined ? { howToApply } : {}),
  };
};

export const applyMemoryGovernance = (
  snapshot: MemorySnapshot | undefined,
  overrides?: Partial<MemoryGovernanceConfig>,
  options?: { now?: string },
): ResolvedMemorySnapshot => {
  const current = createMemorySnapshot(snapshot);
  const config = { ...DEFAULT_MEMORY_GOVERNANCE_CONFIG, ...overrides };
  const now = options?.now ?? new Date().toISOString();

  return createMemorySnapshot({
    ...current,
    working: {
      ...current.working,
      recentFiles: current.working.recentFiles.map((entry) => {
        const content = redact(entry.content, config);
        return {
          ...entry,
          ...(content !== undefined ? { content } : {}),
        };
      }),
      skills: current.working.skills.map((entry) => {
        const content = redact(entry.content, config);
        return {
          ...entry,
          ...(content !== undefined ? { content } : {}),
        };
      }),
      rules: current.working.rules.map((entry) => {
        const content = redact(entry.content, config);
        return {
          ...entry,
          ...(content !== undefined ? { content } : {}),
        };
      }),
      ...(typeof current.working.activePlan === "string"
        ? { activePlan: redact(current.working.activePlan, config) ?? "" }
        : current.working.activePlan !== undefined
          ? { activePlan: current.working.activePlan }
          : {}),
    },
    semantic: {
      entries: current.semantic.entries
        .filter((entry) => daysBetween(entry.updatedAt, now) <= config.maxEntryAgeDays)
        .map((entry) => governSemanticEntry(entry, config)),
    },
    artifacts: {
      preservedContextAssets: current.artifacts.preservedContextAssets.map((asset) => {
        const title = redact(asset.title, config);
        return {
          ...asset,
          content: redact(asset.content, config) ?? "",
          ...(title !== undefined ? { title } : {}),
        };
      }),
    },
  });
};

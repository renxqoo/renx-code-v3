import { applyMemoryGovernance, DEFAULT_MEMORY_GOVERNANCE_CONFIG } from "./governance";
import { applyMemoryPolicy } from "./policy";
import { createMemorySnapshot } from "./snapshot";
import type {
  MemoryNamedContentEntry,
  MemoryRecentFileEntry,
  MemoryScope,
  MemorySemanticEntry,
  MemorySnapshot,
  MemoryTaxonomyType,
  MemoryTenantPolicy,
  ResolvedMemorySnapshot,
} from "./types";

const scopeAllowed = (scope: MemoryScope | undefined, policy: MemoryTenantPolicy): boolean =>
  !scope || !policy.allowedScopes || policy.allowedScopes.includes(scope);

const typeAllowed = (type: MemoryTaxonomyType | undefined, policy: MemoryTenantPolicy): boolean =>
  !type || !policy.allowedTaxonomyTypes || policy.allowedTaxonomyTypes.includes(type);

const stripRecentFile = (
  entry: MemoryRecentFileEntry,
  policy: MemoryTenantPolicy,
): MemoryRecentFileEntry =>
  policy.stripRecentFileContent
    ? (Object.fromEntries(
        Object.entries(entry).filter(([key]) => key !== "content"),
      ) as MemoryRecentFileEntry)
    : entry;

const stripNamedEntry = (
  entry: MemoryNamedContentEntry,
  shouldStrip: boolean | undefined,
): MemoryNamedContentEntry =>
  shouldStrip
    ? (Object.fromEntries(
        Object.entries(entry).filter(([key]) => key !== "content"),
      ) as MemoryNamedContentEntry)
    : entry;

const stripSemanticEntry = (entry: MemorySemanticEntry): MemorySemanticEntry => ({ ...entry });

const hasPolicyLimits = (policy: MemoryTenantPolicy): boolean =>
  policy.maxRecentFiles !== undefined ||
  policy.maxSkills !== undefined ||
  policy.maxRules !== undefined ||
  policy.maxSemanticEntries !== undefined ||
  policy.maxArtifacts !== undefined ||
  policy.maxContentChars !== undefined;

const hasGovernanceOverrides = (policy: MemoryTenantPolicy): boolean =>
  policy.redactEmails !== undefined || policy.redactSecrets !== undefined;

export const applyMemoryTenantPolicy = (
  snapshot: MemorySnapshot | undefined,
  policy: MemoryTenantPolicy | undefined,
): ResolvedMemorySnapshot => {
  if (!policy) return createMemorySnapshot(snapshot);

  const current = createMemorySnapshot(snapshot);
  let next = createMemorySnapshot({
    ...current,
    working: {
      ...current.working,
      recentFiles: current.working.recentFiles
        .filter((entry) => scopeAllowed(entry.scope, policy))
        .map((entry) => stripRecentFile(entry, policy)),
      skills: current.working.skills
        .filter((entry) => scopeAllowed(entry.scope, policy))
        .map((entry) => stripNamedEntry(entry, policy.stripSkillContent)),
      rules: current.working.rules
        .filter((entry) => scopeAllowed(entry.scope, policy))
        .map((entry) => stripNamedEntry(entry, policy.stripRuleContent)),
    },
    semantic: {
      entries: current.semantic.entries
        .filter((entry) => scopeAllowed(entry.scope, policy) && typeAllowed(entry.type, policy))
        .map(stripSemanticEntry),
    },
    artifacts: {
      preservedContextAssets: current.artifacts.preservedContextAssets
        .filter((asset) => scopeAllowed(asset.scope, policy))
        .map((asset) => ({
          ...asset,
          ...(policy.stripArtifactContent ? { content: "" } : {}),
        })),
    },
  });

  if (hasPolicyLimits(policy)) {
    next = applyMemoryPolicy(next, {
      ...(policy.maxRecentFiles !== undefined ? { maxRecentFiles: policy.maxRecentFiles } : {}),
      ...(policy.maxSkills !== undefined ? { maxSkills: policy.maxSkills } : {}),
      ...(policy.maxRules !== undefined ? { maxRules: policy.maxRules } : {}),
      ...(policy.maxSemanticEntries !== undefined
        ? { maxSemanticEntries: policy.maxSemanticEntries }
        : {}),
      ...(policy.maxArtifacts !== undefined ? { maxArtifacts: policy.maxArtifacts } : {}),
      ...(policy.maxContentChars !== undefined ? { maxContentChars: policy.maxContentChars } : {}),
    });
  }

  if (hasGovernanceOverrides(policy)) {
    next = applyMemoryGovernance(next, {
      maxEntryAgeDays: Number.MAX_SAFE_INTEGER,
      redactEmails: policy.redactEmails ?? DEFAULT_MEMORY_GOVERNANCE_CONFIG.redactEmails,
      redactSecrets: policy.redactSecrets ?? DEFAULT_MEMORY_GOVERNANCE_CONFIG.redactSecrets,
    });
  }

  return next;
};

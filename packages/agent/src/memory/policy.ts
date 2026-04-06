import { createMemorySnapshot } from "./snapshot";
import type {
  MemoryNamedContentEntry,
  MemoryPolicy,
  MemoryRecentFileEntry,
  ResolvedMemorySnapshot,
  MemoryScope,
  MemorySemanticEntry,
  MemorySnapshot,
} from "./types";

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = {
  maxRecentFiles: 8,
  maxSkills: 8,
  maxRules: 8,
  maxSemanticEntries: 24,
  maxArtifacts: 24,
  maxContentChars: 4_000,
};

const truncate = (value: string | undefined, maxChars: number): string | undefined => {
  if (value === undefined || value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3)}...`;
};

const trimRecentFile = (
  entry: MemoryRecentFileEntry,
  maxContentChars: number,
): MemoryRecentFileEntry => {
  const content = truncate(entry.content, maxContentChars);
  return {
    ...entry,
    ...(content !== undefined ? { content } : {}),
  };
};

const trimNamedEntry = (
  entry: MemoryNamedContentEntry,
  maxContentChars: number,
): MemoryNamedContentEntry => {
  const content = truncate(entry.content, maxContentChars);
  return {
    ...entry,
    ...(content !== undefined ? { content } : {}),
  };
};

const trimSemanticEntry = (
  entry: MemorySemanticEntry,
  maxContentChars: number,
): MemorySemanticEntry => ({
  ...entry,
  content: truncate(entry.content, maxContentChars) ?? "",
});

export const applyMemoryPolicy = (
  snapshot: MemorySnapshot | undefined,
  overrides?: Partial<MemoryPolicy>,
): ResolvedMemorySnapshot => {
  const resolved = { ...DEFAULT_MEMORY_POLICY, ...overrides };
  const current = createMemorySnapshot(snapshot);

  return createMemorySnapshot({
    ...current,
    working: {
      ...current.working,
      recentFiles: current.working.recentFiles
        .slice(0, resolved.maxRecentFiles)
        .map((entry) => trimRecentFile(entry, resolved.maxContentChars)),
      skills: current.working.skills
        .slice(0, resolved.maxSkills)
        .map((entry) => trimNamedEntry(entry, resolved.maxContentChars)),
      rules: current.working.rules
        .slice(0, resolved.maxRules)
        .map((entry) => trimNamedEntry(entry, resolved.maxContentChars)),
    },
    semantic: {
      entries: current.semantic.entries
        .slice(0, resolved.maxSemanticEntries)
        .map((entry) => trimSemanticEntry(entry, resolved.maxContentChars)),
    },
    artifacts: {
      preservedContextAssets: current.artifacts.preservedContextAssets
        .slice(0, resolved.maxArtifacts)
        .map((asset) => {
          const title = truncate(asset.title, resolved.maxContentChars);
          return {
            ...asset,
            content: truncate(asset.content, resolved.maxContentChars) ?? "",
            ...(title !== undefined ? { title } : {}),
          };
        }),
    },
  });
};

export const extractScopedMemorySnapshot = (
  snapshot: MemorySnapshot | undefined,
  scope: MemoryScope,
): ResolvedMemorySnapshot => {
  const current = createMemorySnapshot(snapshot);
  return createMemorySnapshot({
    working: {
      recentFiles: current.working.recentFiles.filter((entry) => entry.scope === scope),
      skills: current.working.skills.filter((entry) => entry.scope === scope),
      rules: current.working.rules.filter((entry) => entry.scope === scope),
    },
    semantic: {
      entries: current.semantic.entries.filter((entry) => entry.scope === scope),
    },
    artifacts: {
      preservedContextAssets: current.artifacts.preservedContextAssets.filter(
        (asset) => asset.scope === scope,
      ),
    },
  });
};

export const hasMeaningfulMemory = (snapshot: MemorySnapshot | undefined): boolean => {
  const current = createMemorySnapshot(snapshot);
  return (
    current.working.recentFiles.length > 0 ||
    current.working.skills.length > 0 ||
    current.working.rules.length > 0 ||
    current.working.activePlan !== undefined ||
    current.working.hooks !== undefined ||
    current.working.mcpInstructions !== undefined ||
    current.semantic.entries.length > 0 ||
    current.artifacts.preservedContextAssets.length > 0 ||
    current.session !== undefined
  );
};

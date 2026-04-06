import type { PreservedContextAsset } from "../context/types";

import type {
  ArtifactMemoryLayer,
  MemoryNamedContentEntry,
  MemoryRecentFileEntry,
  ResolvedMemorySnapshot,
  MemorySemanticEntry,
  MemorySnapshot,
  SemanticMemoryLayer,
  WorkingMemoryLayer,
} from "./types";

const compareUpdatedAtDesc = (left: string, right: string): number => right.localeCompare(left);

const compareFileEntries = (left: MemoryRecentFileEntry, right: MemoryRecentFileEntry): number => {
  const updatedAt = compareUpdatedAtDesc(left.updatedAt, right.updatedAt);
  if (updatedAt !== 0) return updatedAt;
  return left.path.localeCompare(right.path);
};

const compareNamedEntries = (
  left: MemoryNamedContentEntry,
  right: MemoryNamedContentEntry,
): number => {
  const updatedAt = compareUpdatedAtDesc(left.updatedAt, right.updatedAt);
  if (updatedAt !== 0) return updatedAt;
  return getNamedIdentity(left).localeCompare(getNamedIdentity(right));
};

const compareSemanticEntries = (left: MemorySemanticEntry, right: MemorySemanticEntry): number => {
  const updatedAt = compareUpdatedAtDesc(left.updatedAt, right.updatedAt);
  if (updatedAt !== 0) return updatedAt;
  return right.id.localeCompare(left.id);
};

const compareAssets = (left: PreservedContextAsset, right: PreservedContextAsset): number => {
  const priorityDiff = (right.priority ?? 0) - (left.priority ?? 0);
  if (priorityDiff !== 0) return priorityDiff;
  const updatedAt = compareUpdatedAtDesc(left.updatedAt, right.updatedAt);
  if (updatedAt !== 0) return updatedAt;
  return left.id.localeCompare(right.id);
};

const getNamedIdentity = (entry: MemoryNamedContentEntry): string => entry.path ?? entry.name;

const mergeFileEntries = (
  base: MemoryRecentFileEntry[] | undefined,
  patch: MemoryRecentFileEntry[] | undefined,
): MemoryRecentFileEntry[] => {
  const merged = new Map<string, MemoryRecentFileEntry>();
  for (const entry of [...(base ?? []), ...(patch ?? [])]) {
    merged.set(entry.path, entry);
  }
  return [...merged.values()].sort(compareFileEntries);
};

const mergeNamedEntries = (
  base: MemoryNamedContentEntry[] | undefined,
  patch: MemoryNamedContentEntry[] | undefined,
): MemoryNamedContentEntry[] => {
  const merged = new Map<string, MemoryNamedContentEntry>();
  for (const entry of [...(base ?? []), ...(patch ?? [])]) {
    merged.set(getNamedIdentity(entry), entry);
  }
  return [...merged.values()].sort(compareNamedEntries);
};

const mergeSemanticEntries = (
  base: MemorySemanticEntry[] | undefined,
  patch: MemorySemanticEntry[] | undefined,
): MemorySemanticEntry[] => {
  const merged = new Map<string, MemorySemanticEntry>();
  for (const entry of [...(base ?? []), ...(patch ?? [])]) {
    merged.set(entry.id, entry);
  }
  return [...merged.values()].sort(compareSemanticEntries);
};

const mergeAssets = (
  base: PreservedContextAsset[] | undefined,
  patch: PreservedContextAsset[] | undefined,
): PreservedContextAsset[] => {
  const merged = new Map<string, PreservedContextAsset>();
  for (const entry of [...(base ?? []), ...(patch ?? [])]) {
    merged.set(entry.id, entry);
  }
  return [...merged.values()].sort(compareAssets);
};

const hasStructuredLayers = (snapshot: MemorySnapshot | undefined): boolean =>
  !!snapshot &&
  typeof snapshot === "object" &&
  ("working" in snapshot ||
    "session" in snapshot ||
    "semantic" in snapshot ||
    "artifacts" in snapshot);

export const createMemorySnapshot = (snapshot?: MemorySnapshot): ResolvedMemorySnapshot => {
  const extras =
    snapshot && typeof snapshot === "object"
      ? Object.fromEntries(
          Object.entries(snapshot).filter(
            ([key]) =>
              key !== "working" && key !== "session" && key !== "semantic" && key !== "artifacts",
          ),
        )
      : {};
  const working: WorkingMemoryLayer = {
    recentFiles: mergeFileEntries(undefined, snapshot?.working?.recentFiles),
    ...(snapshot?.working?.activePlan !== undefined
      ? { activePlan: snapshot.working.activePlan }
      : {}),
    skills: mergeNamedEntries(undefined, snapshot?.working?.skills),
    rules: mergeNamedEntries(undefined, snapshot?.working?.rules),
    ...(snapshot?.working?.hooks !== undefined ? { hooks: snapshot.working.hooks } : {}),
    ...(snapshot?.working?.mcpInstructions !== undefined
      ? { mcpInstructions: snapshot.working.mcpInstructions }
      : {}),
  };
  const semantic: SemanticMemoryLayer = {
    entries: mergeSemanticEntries(undefined, snapshot?.semantic?.entries),
  };
  const artifacts: ArtifactMemoryLayer = {
    preservedContextAssets: mergeAssets(undefined, snapshot?.artifacts?.preservedContextAssets),
  };

  return {
    ...extras,
    working,
    ...(snapshot?.session ? { session: { ...snapshot.session } } : {}),
    semantic,
    artifacts,
  } as ResolvedMemorySnapshot;
};

export const mergeMemorySnapshot = (
  base: MemorySnapshot | undefined,
  patch: MemorySnapshot | undefined,
): ResolvedMemorySnapshot => {
  if (!hasStructuredLayers(base) && !hasStructuredLayers(patch)) {
    return {
      ...(base ?? {}),
      ...(patch ?? {}),
    } as ResolvedMemorySnapshot;
  }

  const current = createMemorySnapshot(base);
  const next = createMemorySnapshot(patch);
  const extras = Object.fromEntries(
    [...Object.entries(current), ...Object.entries(next)].filter(
      ([key]) =>
        key !== "working" && key !== "session" && key !== "semantic" && key !== "artifacts",
    ),
  );

  return {
    ...extras,
    working: {
      recentFiles: mergeFileEntries(current.working?.recentFiles, next.working?.recentFiles),
      ...(next.working?.activePlan !== undefined
        ? { activePlan: next.working.activePlan }
        : current.working?.activePlan !== undefined
          ? { activePlan: current.working.activePlan }
          : {}),
      skills: mergeNamedEntries(current.working?.skills, next.working?.skills),
      rules: mergeNamedEntries(current.working?.rules, next.working?.rules),
      ...(next.working?.hooks !== undefined
        ? { hooks: next.working.hooks }
        : current.working?.hooks !== undefined
          ? { hooks: current.working.hooks }
          : {}),
      ...(next.working?.mcpInstructions !== undefined
        ? { mcpInstructions: next.working.mcpInstructions }
        : current.working?.mcpInstructions !== undefined
          ? { mcpInstructions: current.working.mcpInstructions }
          : {}),
    },
    ...(next.session
      ? { session: { ...(current.session ?? {}), ...next.session } }
      : current.session
        ? { session: current.session }
        : {}),
    semantic: {
      entries: mergeSemanticEntries(current.semantic?.entries, next.semantic?.entries),
    },
    artifacts: {
      preservedContextAssets: mergeAssets(
        current.artifacts?.preservedContextAssets,
        next.artifacts?.preservedContextAssets,
      ),
    },
  } as ResolvedMemorySnapshot;
};

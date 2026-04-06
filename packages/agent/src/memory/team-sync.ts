import { createHash } from "node:crypto";

import { checkSharedMemorySnapshotForSecrets } from "./secret-guard";
import { createMemorySnapshot } from "./snapshot";
import type {
  MemoryEvent,
  MemoryHooks,
  MemoryScope,
  MemorySnapshot,
  ScopedMemoryStore,
} from "./types";

export interface MemoryTeamSyncState {
  lastKnownChecksum: string | null;
  serverChecksums: Record<string, string>;
  serverMaxEntries: number | null;
  lastSyncAt?: string;
}

export interface MemoryRemoteEntry {
  key: string;
  content: string;
  checksum?: string;
}

export interface MemoryRemotePullResult {
  status: "ok" | "not_modified" | "not_found";
  checksum?: string;
  entryChecksums?: Record<string, string>;
  entries?: MemoryRemoteEntry[];
  maxEntries?: number | null;
}

export interface MemoryRemotePushResult {
  status: "ok" | "conflict" | "too_many_entries" | "error";
  checksum?: string;
  entryChecksums?: Record<string, string>;
  maxEntries?: number | null;
  message?: string;
}

export interface MemoryRemoteTransport {
  pull(input: {
    scope: MemoryScope;
    namespace: string;
    ifNoneMatch?: string | null;
  }): Promise<MemoryRemotePullResult> | MemoryRemotePullResult;
  pullHashes(input: {
    scope: MemoryScope;
    namespace: string;
  }): Promise<Omit<MemoryRemotePullResult, "entries">> | Omit<MemoryRemotePullResult, "entries">;
  push(input: {
    scope: MemoryScope;
    namespace: string;
    ifMatch?: string | null;
    entries: MemoryRemoteEntry[];
  }): Promise<MemoryRemotePushResult> | MemoryRemotePushResult;
}

export interface MemoryTeamSyncServiceOptions {
  maxConflictRetries?: number;
  maxBatchBytes?: number;
  hooks?: MemoryHooks;
}

export interface MemoryTeamSyncPullResult {
  status: "updated" | "not_modified" | "not_found";
  entryCount: number;
  checksum?: string;
}

export interface MemoryTeamSyncPushResult {
  status: "synced" | "too_many_entries" | "error";
  uploadedEntryCount: number;
  skippedSecretEntryKeys: string[];
  checksum?: string;
  message?: string;
}

type StoredRemoteState = {
  entries: Record<string, string>;
  checksum: string | null;
  maxEntries: number | null;
};

const DEFAULT_MAX_CONFLICT_RETRIES = 2;
const DEFAULT_MAX_BATCH_BYTES = 128_000;

const hashContent = (content: string): string =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;

const encodeKey = (value: string): string => encodeURIComponent(value);
const decodeKey = (value: string): string => decodeURIComponent(value);

const toRemoteEntries = (snapshot: MemorySnapshot | undefined): MemoryRemoteEntry[] => {
  const current = createMemorySnapshot(snapshot);
  const entries: MemoryRemoteEntry[] = [];

  for (const entry of current.working.recentFiles) {
    entries.push({
      key: `working/recentFiles/${encodeKey(entry.path)}`,
      content: JSON.stringify(entry),
    });
  }
  for (const entry of current.working.skills) {
    entries.push({
      key: `working/skills/${encodeKey(entry.path ?? entry.name)}`,
      content: JSON.stringify(entry),
    });
  }
  for (const entry of current.working.rules) {
    entries.push({
      key: `working/rules/${encodeKey(entry.path ?? entry.name)}`,
      content: JSON.stringify(entry),
    });
  }
  if (current.working.activePlan !== undefined) {
    entries.push({
      key: "working/activePlan",
      content: JSON.stringify(current.working.activePlan),
    });
  }
  if (current.working.hooks !== undefined) {
    entries.push({
      key: "working/hooks",
      content: JSON.stringify(current.working.hooks),
    });
  }
  if (current.working.mcpInstructions !== undefined) {
    entries.push({
      key: "working/mcpInstructions",
      content: JSON.stringify(current.working.mcpInstructions),
    });
  }
  for (const entry of current.semantic.entries) {
    entries.push({
      key: `semantic/${encodeKey(entry.id)}`,
      content: JSON.stringify(entry),
    });
  }
  for (const asset of current.artifacts.preservedContextAssets) {
    entries.push({
      key: `artifacts/${encodeKey(asset.id)}`,
      content: JSON.stringify(asset),
    });
  }

  return entries.sort((left, right) => left.key.localeCompare(right.key));
};

const fromRemoteEntries = (entries: MemoryRemoteEntry[]): MemorySnapshot => {
  const workingRecentFiles: Array<Record<string, unknown>> = [];
  const workingSkills: Array<Record<string, unknown>> = [];
  const workingRules: Array<Record<string, unknown>> = [];
  const semanticEntries: Array<Record<string, unknown>> = [];
  const preservedContextAssets: Array<Record<string, unknown>> = [];
  let activePlan: unknown = undefined;
  let hooks: unknown = undefined;
  let mcpInstructions: unknown = undefined;

  for (const entry of entries) {
    if (entry.key.startsWith("working/recentFiles/")) {
      workingRecentFiles.push(JSON.parse(entry.content) as Record<string, unknown>);
      continue;
    }
    if (entry.key.startsWith("working/skills/")) {
      workingSkills.push(JSON.parse(entry.content) as Record<string, unknown>);
      continue;
    }
    if (entry.key.startsWith("working/rules/")) {
      workingRules.push(JSON.parse(entry.content) as Record<string, unknown>);
      continue;
    }
    if (entry.key === "working/activePlan") {
      activePlan = JSON.parse(entry.content);
      continue;
    }
    if (entry.key === "working/hooks") {
      hooks = JSON.parse(entry.content);
      continue;
    }
    if (entry.key === "working/mcpInstructions") {
      mcpInstructions = JSON.parse(entry.content);
      continue;
    }
    if (entry.key.startsWith("semantic/")) {
      semanticEntries.push(JSON.parse(entry.content) as Record<string, unknown>);
      continue;
    }
    if (entry.key.startsWith("artifacts/")) {
      preservedContextAssets.push(JSON.parse(entry.content) as Record<string, unknown>);
    }
  }

  return createMemorySnapshot({
    working: {
      recentFiles: workingRecentFiles as never,
      skills: workingSkills as never,
      rules: workingRules as never,
      ...(activePlan !== undefined && activePlan !== null
        ? { activePlan: activePlan as never }
        : {}),
      ...(hooks !== undefined && hooks !== null ? { hooks } : {}),
      ...(mcpInstructions !== undefined && mcpInstructions !== null ? { mcpInstructions } : {}),
    },
    semantic: {
      entries: semanticEntries as never,
    },
    artifacts: {
      preservedContextAssets: preservedContextAssets as never,
    },
  });
};

const withChecksums = (entries: MemoryRemoteEntry[]): MemoryRemoteEntry[] =>
  entries.map((entry) => ({
    ...entry,
    checksum: entry.checksum ?? hashContent(entry.content),
  }));

const toChecksumMap = (entries: MemoryRemoteEntry[]): Record<string, string> =>
  Object.fromEntries(withChecksums(entries).map((entry) => [entry.key, entry.checksum!]));

const computeSnapshotChecksum = (entries: MemoryRemoteEntry[]): string =>
  hashContent(
    withChecksums(entries)
      .map((entry) => `${entry.key}:${entry.checksum}`)
      .sort((left, right) => left.localeCompare(right))
      .join("\n"),
  );

const splitIntoBatches = (
  entries: MemoryRemoteEntry[],
  maxBatchBytes: number,
): MemoryRemoteEntry[][] => {
  const batches: MemoryRemoteEntry[][] = [];
  let currentBatch: MemoryRemoteEntry[] = [];
  let currentBytes = 0;

  for (const entry of entries) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
    if (currentBatch.length > 0 && currentBytes + entryBytes > maxBatchBytes) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }
    currentBatch.push(entry);
    currentBytes += entryBytes;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
};

export const createMemoryTeamSyncState = (): MemoryTeamSyncState => ({
  lastKnownChecksum: null,
  serverChecksums: {},
  serverMaxEntries: null,
});

export class InMemoryMemoryRemoteTransport implements MemoryRemoteTransport {
  private readonly states = new Map<string, StoredRemoteState>();
  private readonly pendingConflictMutations: Array<(snapshot: MemorySnapshot) => MemorySnapshot> =
    [];

  async replace(scope: MemoryScope, namespace: string, snapshot: MemorySnapshot): Promise<void> {
    const entries = withChecksums(toRemoteEntries(snapshot));
    this.states.set(this.key(scope, namespace), {
      entries: Object.fromEntries(entries.map((entry) => [entry.key, entry.content])),
      checksum: entries.length > 0 ? computeSnapshotChecksum(entries) : null,
      maxEntries: this.states.get(this.key(scope, namespace))?.maxEntries ?? null,
    });
  }

  async loadSnapshot(scope: MemoryScope, namespace: string): Promise<MemorySnapshot> {
    const state = this.states.get(this.key(scope, namespace));
    if (!state) return createMemorySnapshot();
    return fromRemoteEntries(
      Object.entries(state.entries).map(([key, content]) => ({
        key,
        content,
        checksum: hashContent(content),
      })),
    );
  }

  setMaxEntries(scope: MemoryScope, namespace: string, maxEntries: number | null): void {
    const key = this.key(scope, namespace);
    const current = this.states.get(key) ?? { entries: {}, checksum: null, maxEntries: null };
    this.states.set(key, {
      ...current,
      maxEntries,
    });
  }

  injectConflictOnce(mutator: (snapshot: MemorySnapshot) => MemorySnapshot): void {
    this.pendingConflictMutations.push(mutator);
  }

  async pull(input: {
    scope: MemoryScope;
    namespace: string;
    ifNoneMatch?: string | null;
  }): Promise<MemoryRemotePullResult> {
    const state = this.states.get(this.key(input.scope, input.namespace));
    if (!state || state.checksum === null) {
      return { status: "not_found" };
    }
    if (input.ifNoneMatch && input.ifNoneMatch === state.checksum) {
      return {
        status: "not_modified",
        checksum: state.checksum,
        maxEntries: state.maxEntries,
      };
    }
    const entries = Object.entries(state.entries).map(([key, content]) => ({
      key,
      content,
      checksum: hashContent(content),
    }));
    return {
      status: "ok",
      checksum: state.checksum,
      entryChecksums: toChecksumMap(entries),
      entries,
      maxEntries: state.maxEntries,
    };
  }

  async pullHashes(input: {
    scope: MemoryScope;
    namespace: string;
  }): Promise<Omit<MemoryRemotePullResult, "entries">> {
    const state = this.states.get(this.key(input.scope, input.namespace));
    if (!state || state.checksum === null) {
      return { status: "not_found" };
    }
    const entries = Object.entries(state.entries).map(([key, content]) => ({
      key,
      content,
      checksum: hashContent(content),
    }));
    return {
      status: "ok",
      checksum: state.checksum,
      entryChecksums: toChecksumMap(entries),
      maxEntries: state.maxEntries,
    };
  }

  async push(input: {
    scope: MemoryScope;
    namespace: string;
    ifMatch?: string | null;
    entries: MemoryRemoteEntry[];
  }): Promise<MemoryRemotePushResult> {
    const key = this.key(input.scope, input.namespace);
    const current = this.states.get(key) ?? { entries: {}, checksum: null, maxEntries: null };

    if (this.pendingConflictMutations.length > 0) {
      const mutation = this.pendingConflictMutations.shift()!;
      const mutatedSnapshot = mutation(
        fromRemoteEntries(
          Object.entries(current.entries).map(([entryKey, content]) => ({
            key: entryKey,
            content,
            checksum: hashContent(content),
          })),
        ),
      );
      await this.replace(input.scope, input.namespace, mutatedSnapshot);
      const mutated = this.states.get(key)!;
      return {
        status: "conflict",
        ...(mutated.checksum ? { checksum: mutated.checksum } : {}),
        entryChecksums: Object.fromEntries(
          Object.entries(mutated.entries).map(([entryKey, content]) => [
            entryKey,
            hashContent(content),
          ]),
        ),
        maxEntries: mutated.maxEntries,
      };
    }

    if (current.checksum && input.ifMatch && input.ifMatch !== current.checksum) {
      return {
        status: "conflict",
        ...(current.checksum ? { checksum: current.checksum } : {}),
        entryChecksums: Object.fromEntries(
          Object.entries(current.entries).map(([entryKey, content]) => [
            entryKey,
            hashContent(content),
          ]),
        ),
        maxEntries: current.maxEntries,
      };
    }

    const nextEntries = {
      ...current.entries,
      ...Object.fromEntries(
        withChecksums(input.entries).map((entry) => [entry.key, entry.content]),
      ),
    };

    if (current.maxEntries !== null && Object.keys(nextEntries).length > current.maxEntries) {
      return {
        status: "too_many_entries",
        ...(current.checksum ? { checksum: current.checksum } : {}),
        entryChecksums: Object.fromEntries(
          Object.entries(current.entries).map(([entryKey, content]) => [
            entryKey,
            hashContent(content),
          ]),
        ),
        maxEntries: current.maxEntries,
        message: `Remote max entries exceeded (${current.maxEntries}).`,
      };
    }

    const nextEntryList = Object.entries(nextEntries).map(([entryKey, content]) => ({
      key: entryKey,
      content,
      checksum: hashContent(content),
    }));
    const checksum = computeSnapshotChecksum(nextEntryList);
    this.states.set(key, {
      entries: nextEntries,
      checksum,
      maxEntries: current.maxEntries,
    });

    return {
      status: "ok",
      checksum,
      entryChecksums: toChecksumMap(nextEntryList),
      maxEntries: current.maxEntries,
    };
  }

  private key(scope: MemoryScope, namespace: string): string {
    return `${scope}:${namespace}`;
  }
}

export class MemoryTeamSyncService {
  private readonly maxConflictRetries: number;
  private readonly maxBatchBytes: number;

  constructor(
    private readonly scopedStore: ScopedMemoryStore,
    private readonly remoteTransport: MemoryRemoteTransport,
    private readonly options: MemoryTeamSyncServiceOptions = {},
  ) {
    this.maxConflictRetries = options.maxConflictRetries ?? DEFAULT_MAX_CONFLICT_RETRIES;
    this.maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
  }

  async pull(input: {
    scope: MemoryScope;
    namespace: string;
    state: MemoryTeamSyncState;
  }): Promise<MemoryTeamSyncPullResult> {
    const pulled = await this.remoteTransport.pull({
      scope: input.scope,
      namespace: input.namespace,
      ifNoneMatch: input.state.lastKnownChecksum,
    });

    if (pulled.status === "not_found") {
      return { status: "not_found", entryCount: 0 };
    }
    if (pulled.status === "not_modified") {
      input.state.lastSyncAt = new Date().toISOString();
      return {
        status: "not_modified",
        entryCount: 0,
        ...(pulled.checksum ? { checksum: pulled.checksum } : {}),
      };
    }

    const snapshot = fromRemoteEntries(withChecksums(pulled.entries ?? []));
    await this.scopedStore.save(input.scope, input.namespace, snapshot);
    input.state.lastKnownChecksum = pulled.checksum ?? null;
    input.state.serverChecksums = pulled.entryChecksums ?? {};
    input.state.serverMaxEntries = pulled.maxEntries ?? null;
    input.state.lastSyncAt = new Date().toISOString();
    await this.emit("memory_team_sync_pull_completed", input.namespace, {
      scope: input.scope,
      entryCount: pulled.entries?.length ?? 0,
      checksum: pulled.checksum,
    });
    return {
      status: "updated",
      entryCount: pulled.entries?.length ?? 0,
      ...(pulled.checksum ? { checksum: pulled.checksum } : {}),
    };
  }

  async push(input: {
    scope: MemoryScope;
    namespace: string;
    state: MemoryTeamSyncState;
  }): Promise<MemoryTeamSyncPushResult> {
    const localSnapshot = createMemorySnapshot(
      (await this.scopedStore.load(input.scope, input.namespace)) ?? undefined,
    );
    const secretReport = checkSharedMemorySnapshotForSecrets(localSnapshot);
    const allEntries = withChecksums(toRemoteEntries(localSnapshot));
    const skippedSecretEntryKeys = new Set(
      secretReport.issues.map((issue) => {
        const [group, id] = issue.key.split("/", 2);
        return group === "semantic" && id ? `semantic/${encodeKey(id)}` : issue.key;
      }),
    );
    const safeEntries = allEntries.filter((entry) => !skippedSecretEntryKeys.has(entry.key));

    if (skippedSecretEntryKeys.size > 0) {
      await this.emit("memory_team_sync_secret_skipped", input.namespace, {
        scope: input.scope,
        skippedEntryCount: skippedSecretEntryKeys.size,
      });
    }

    if (
      input.state.serverMaxEntries !== null &&
      safeEntries.length > input.state.serverMaxEntries
    ) {
      return {
        status: "too_many_entries",
        uploadedEntryCount: 0,
        skippedSecretEntryKeys: secretReport.issues.map((issue) => issue.key),
        message: `Remote max entries exceeded (${input.state.serverMaxEntries}).`,
      };
    }

    let uploadedEntryCount = 0;

    for (let attempt = 0; attempt <= this.maxConflictRetries; attempt += 1) {
      const delta = safeEntries.filter(
        (entry) => input.state.serverChecksums[entry.key] !== entry.checksum,
      );

      if (delta.length === 0) {
        input.state.lastSyncAt = new Date().toISOString();
        await this.emit("memory_team_sync_push_completed", input.namespace, {
          scope: input.scope,
          uploadedEntryCount,
          skippedSecretEntryCount: skippedSecretEntryKeys.size,
        });
        return {
          status: "synced",
          uploadedEntryCount,
          skippedSecretEntryKeys: secretReport.issues.map((issue) => issue.key),
          ...(input.state.lastKnownChecksum ? { checksum: input.state.lastKnownChecksum } : {}),
        };
      }

      const batches = splitIntoBatches(delta, this.maxBatchBytes);
      let conflictDetected = false;

      for (const batch of batches) {
        const pushed = await this.remoteTransport.push({
          scope: input.scope,
          namespace: input.namespace,
          ifMatch: input.state.lastKnownChecksum,
          entries: batch,
        });

        if (pushed.status === "ok") {
          input.state.lastKnownChecksum = pushed.checksum ?? input.state.lastKnownChecksum;
          input.state.serverChecksums = {
            ...input.state.serverChecksums,
            ...(pushed.entryChecksums ??
              Object.fromEntries(batch.map((entry) => [entry.key, entry.checksum!]))),
          };
          input.state.serverMaxEntries = pushed.maxEntries ?? input.state.serverMaxEntries;
          uploadedEntryCount += batch.length;
          continue;
        }

        if (pushed.status === "too_many_entries") {
          input.state.serverMaxEntries = pushed.maxEntries ?? input.state.serverMaxEntries;
          return {
            status: "too_many_entries",
            uploadedEntryCount,
            skippedSecretEntryKeys: secretReport.issues.map((issue) => issue.key),
            ...(pushed.checksum ? { checksum: pushed.checksum } : {}),
            ...(pushed.message ? { message: pushed.message } : {}),
          };
        }

        if (pushed.status === "conflict") {
          conflictDetected = true;
          input.state.lastKnownChecksum = pushed.checksum ?? input.state.lastKnownChecksum;
          await this.emit("memory_team_sync_conflict", input.namespace, {
            scope: input.scope,
            attempt,
          });
          break;
        }

        return {
          status: "error",
          uploadedEntryCount,
          skippedSecretEntryKeys: secretReport.issues.map((issue) => issue.key),
          ...(pushed.checksum ? { checksum: pushed.checksum } : {}),
          message: pushed.message ?? "Remote push failed.",
        };
      }

      if (!conflictDetected) {
        input.state.lastSyncAt = new Date().toISOString();
        await this.emit("memory_team_sync_push_completed", input.namespace, {
          scope: input.scope,
          uploadedEntryCount,
          skippedSecretEntryCount: skippedSecretEntryKeys.size,
        });
        return {
          status: "synced",
          uploadedEntryCount,
          skippedSecretEntryKeys: secretReport.issues.map((issue) => issue.key),
          ...(input.state.lastKnownChecksum ? { checksum: input.state.lastKnownChecksum } : {}),
        };
      }

      const hashes = await this.remoteTransport.pullHashes({
        scope: input.scope,
        namespace: input.namespace,
      });
      if (hashes.status !== "ok") {
        return {
          status: "error",
          uploadedEntryCount,
          skippedSecretEntryKeys: secretReport.issues.map((issue) => issue.key),
          message: "Failed to refresh remote hashes after conflict.",
        };
      }
      input.state.lastKnownChecksum = hashes.checksum ?? input.state.lastKnownChecksum;
      input.state.serverChecksums = hashes.entryChecksums ?? input.state.serverChecksums;
      input.state.serverMaxEntries = hashes.maxEntries ?? input.state.serverMaxEntries;
    }

    return {
      status: "error",
      uploadedEntryCount,
      skippedSecretEntryKeys: secretReport.issues.map((issue) => issue.key),
      message: "Conflict retries exhausted.",
    };
  }

  private async emit(
    type: Extract<
      MemoryEvent["type"],
      | "memory_team_sync_pull_completed"
      | "memory_team_sync_push_completed"
      | "memory_team_sync_conflict"
      | "memory_team_sync_secret_skipped"
    >,
    runId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.options.hooks?.onEvent({
      type,
      runId,
      timestamp: new Date().toISOString(),
      payload,
    });
  }
}

export const decodeRemoteMemoryEntryKey = (value: string): string => {
  const segments = value.split("/");
  const lastSegment = segments.at(-1);
  return lastSegment ? decodeKey(lastSegment) : value;
};

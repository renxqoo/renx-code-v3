import type { PlatformAgentRecord, PlatformShellCommandRecord } from "./shared";

type BackgroundTaskKind = "agent" | "shell";

interface BackgroundTaskEntry<TRecord> {
  kind: BackgroundTaskKind;
  current: TRecord;
  refresh?: () => Promise<TRecord>;
}

const store = new Map<
  string,
  BackgroundTaskEntry<PlatformAgentRecord | PlatformShellCommandRecord>
>();

const buildKey = (runId: string, taskId: string): string => `${runId}:${taskId}`;

const isShellReady = (record: PlatformShellCommandRecord): boolean => record.status !== "running";

const isAgentReady = (record: PlatformAgentRecord): boolean =>
  record.status !== "running" && record.status !== "paused";

const getEntry = (
  runId: string,
  taskId: string,
): BackgroundTaskEntry<PlatformAgentRecord | PlatformShellCommandRecord> | undefined =>
  store.get(buildKey(runId, taskId));

export const registerBackgroundShellTask = (
  runId: string,
  taskId: string,
  initial: PlatformShellCommandRecord,
): {
  set(record: PlatformShellCommandRecord): PlatformShellCommandRecord;
  update(
    updater: (current: PlatformShellCommandRecord) => PlatformShellCommandRecord,
  ): PlatformShellCommandRecord;
} => {
  const entry: BackgroundTaskEntry<PlatformShellCommandRecord> = {
    kind: "shell",
    current: initial,
  };
  store.set(buildKey(runId, taskId), entry);
  return {
    set: (record) => {
      entry.current = record;
      return entry.current;
    },
    update: (updater) => {
      entry.current = updater(entry.current);
      return entry.current;
    },
  };
};

export const registerBackgroundAgentTask = (
  runId: string,
  taskId: string,
  initial: PlatformAgentRecord,
  options?: {
    refresh?: () => Promise<PlatformAgentRecord>;
  },
): {
  set(record: PlatformAgentRecord): PlatformAgentRecord;
  update(updater: (current: PlatformAgentRecord) => PlatformAgentRecord): PlatformAgentRecord;
} => {
  const entry: BackgroundTaskEntry<PlatformAgentRecord> = {
    kind: "agent",
    current: initial,
    ...(options?.refresh ? { refresh: options.refresh } : {}),
  };
  store.set(buildKey(runId, taskId), entry);
  return {
    set: (record) => {
      entry.current = record;
      return entry.current;
    },
    update: (updater) => {
      entry.current = updater(entry.current);
      return entry.current;
    },
  };
};

export const getBackgroundShellTaskSnapshot = async (
  runId: string,
  taskId: string,
): Promise<PlatformShellCommandRecord | undefined> => {
  const entry = getEntry(runId, taskId);
  if (!entry || entry.kind !== "shell") return undefined;
  return entry.current as PlatformShellCommandRecord;
};

export const getBackgroundAgentTaskSnapshot = async (
  runId: string,
  taskId: string,
): Promise<PlatformAgentRecord | undefined> => {
  const entry = getEntry(runId, taskId);
  if (!entry || entry.kind !== "agent") return undefined;
  if (entry.refresh) {
    entry.current = await entry.refresh();
  }
  return entry.current as PlatformAgentRecord;
};

export const waitForBackgroundShellTask = async (
  runId: string,
  taskId: string,
  timeoutMs: number,
): Promise<PlatformShellCommandRecord | undefined> => {
  const entry = getEntry(runId, taskId);
  if (!entry || entry.kind !== "shell") return undefined;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (isShellReady(entry.current as PlatformShellCommandRecord)) {
      return entry.current as PlatformShellCommandRecord;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  return isShellReady(entry.current as PlatformShellCommandRecord)
    ? (entry.current as PlatformShellCommandRecord)
    : undefined;
};

export const waitForBackgroundAgentTask = async (
  runId: string,
  taskId: string,
  timeoutMs: number,
): Promise<PlatformAgentRecord | undefined> => {
  const entry = getEntry(runId, taskId);
  if (!entry || entry.kind !== "agent") return undefined;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (entry.refresh) {
      entry.current = await entry.refresh();
    }
    if (isAgentReady(entry.current as PlatformAgentRecord)) {
      return entry.current as PlatformAgentRecord;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  if (entry.refresh) {
    entry.current = await entry.refresh();
  }
  return isAgentReady(entry.current as PlatformAgentRecord)
    ? (entry.current as PlatformAgentRecord)
    : undefined;
};

export const markBackgroundTaskCancelled = async (runId: string, taskId: string): Promise<void> => {
  const entry = getEntry(runId, taskId);
  if (!entry) return;
  if (entry.kind === "shell") {
    entry.current = {
      ...(entry.current as PlatformShellCommandRecord),
      status: "cancelled",
      finishedAt: new Date().toISOString(),
    };
    return;
  }
  entry.current = {
    ...(entry.current as PlatformAgentRecord),
    status: "cancelled",
    updatedAt: new Date().toISOString(),
  };
};

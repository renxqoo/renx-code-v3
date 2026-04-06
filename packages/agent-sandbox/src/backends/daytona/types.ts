import type { CodeLanguage, DaytonaConfig, Image, Resources } from "@daytonaio/sdk";

export interface DaytonaSandboxVolumeSpec {
  volumeId?: string;
  volumeName?: string;
  createIfMissing?: boolean;
  mountPath: string;
  subpath?: string;
}

export interface DaytonaSandboxBlueprint {
  name?: string;
  user?: string;
  language?: CodeLanguage | string;
  image?: string | Image;
  snapshot?: string;
  resources?: Resources;
  envVars?: Record<string, string>;
  labels?: Record<string, string>;
  public?: boolean;
  autoStopInterval?: number;
  autoArchiveInterval?: number;
  autoDeleteInterval?: number;
  volumes?: DaytonaSandboxVolumeSpec[];
  networkBlockAll?: boolean;
  networkAllowList?: string;
  ephemeral?: boolean;
  timeoutSec?: number;
  onSnapshotCreateLogs?: (chunk: string) => void;
}

export interface DaytonaSandboxMetadata {
  daytona?: DaytonaSandboxBlueprint;
}

export interface DaytonaSandboxResolvedVolume {
  volumeId: string;
  mountPath: string;
  subpath?: string;
}

export interface DaytonaSandboxCreateRequest extends Omit<DaytonaSandboxBlueprint, "volumes"> {
  volumes?: DaytonaSandboxResolvedVolume[];
}

export interface DaytonaSandboxSessionExecuteResponse {
  cmdId: string;
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface DaytonaSandboxProcessHandle {
  createSession(sessionId: string): Promise<void>;
  executeSessionCommand(
    sessionId: string,
    request: {
      command: string;
      runAsync?: boolean;
      suppressInputEcho?: boolean;
    },
    timeoutSec?: number,
  ): Promise<DaytonaSandboxSessionExecuteResponse>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface DaytonaSandboxFileInfo {
  group: string;
  isDir: boolean;
  modTime: string;
  mode: string;
  name: string;
  owner: string;
  permissions: string;
  size: number;
}

export interface DaytonaSandboxFileSystemHandle {
  uploadFile(file: Buffer, remotePath: string, timeoutSec?: number): Promise<void>;
  downloadFile(remotePath: string, timeoutSec?: number): Promise<Buffer>;
  listFiles(path: string): Promise<DaytonaSandboxFileInfo[]>;
  getFileDetails(path: string): Promise<DaytonaSandboxFileInfo>;
  deleteFile(path: string, recursive?: boolean): Promise<void>;
}

export interface DaytonaSandboxHandle {
  id: string;
  name: string;
  state?: string;
  recoverable?: boolean;
  getWorkDir(): Promise<string | undefined>;
  start(timeoutSec?: number): Promise<void>;
  stop(timeoutSec?: number, force?: boolean): Promise<void>;
  archive(): Promise<void>;
  delete(timeoutSec?: number): Promise<void>;
  recover(timeoutSec?: number): Promise<void>;
  waitUntilStarted(timeoutSec?: number): Promise<void>;
  refreshData(): Promise<void>;
  process: DaytonaSandboxProcessHandle;
  fs: DaytonaSandboxFileSystemHandle;
}

export interface DaytonaSandboxVolumeHandle {
  id: string;
  name: string;
}

export interface DaytonaSandboxClientLike {
  verifyConnection(): Promise<void>;
  getSandbox(idOrName: string): Promise<DaytonaSandboxHandle | undefined>;
  createSandbox(request: DaytonaSandboxCreateRequest): Promise<DaytonaSandboxHandle>;
  getVolumeByName(name: string, createIfMissing?: boolean): Promise<DaytonaSandboxVolumeHandle>;
  getVolumeById(volumeId: string): Promise<DaytonaSandboxVolumeHandle | undefined>;
}

export type DaytonaSandboxReleaseMode = "delete" | "stop" | "archive";

export interface DaytonaSandboxProviderOptions {
  kind?: string;
  platform?: string;
  config?: DaytonaConfig;
  defaults?: Omit<DaytonaSandboxBlueprint, "name">;
  releaseMode?: DaytonaSandboxReleaseMode;
  client?: DaytonaSandboxClientLike;
}

export interface DaytonaSandboxPlatformOptions {
  kind?: string;
  config?: DaytonaConfig;
  client?: DaytonaSandboxClientLike;
}

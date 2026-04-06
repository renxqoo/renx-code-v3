import type {
  AgentMiddleware,
  AgentRunContext,
  AgentTool,
  BackendCapabilities,
  BackendResolver,
  BackendSession,
  CreateSessionOptions,
  ExecOptions,
  ExecResult,
  ExecutionBackend,
  FileInfo,
} from "@renx/agent";
import type { ToolCall } from "@renx/model";

export interface SandboxCommandPolicy {
  allowNetwork: boolean;
  allowedWriteRoots: string[];
  blockedCommandPatterns: RegExp[];
  maxExecutionTimeoutMs: number;
  allowedEnvironmentKeys?: string[];
}

export type SandboxIsolationMode = "host" | "memory" | "process" | "container" | "remote";

export type SandboxFileErrorCode =
  | "file_not_found"
  | "permission_denied"
  | "is_directory"
  | "invalid_path";

export interface SandboxLease {
  leaseId: string;
  provider?: string;
  sandboxId?: string;
  platform: string;
  workspaceRoot: string;
  mountPath?: string;
  snapshotId?: string;
  capabilities?: BackendCapabilities;
  createdAt?: string;
  policy?: Partial<SandboxCommandPolicy>;
  metadata?: Record<string, unknown>;
}

export interface SandboxExecRequest {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface SandboxExecResult extends ExecResult {}

export interface SandboxFileDownloadResult {
  path: string;
  content?: Uint8Array;
  error?: SandboxFileErrorCode | string;
}

export interface SandboxFileUploadResult {
  path: string;
  error?: SandboxFileErrorCode | string;
}

export interface SandboxRuntimeExecuteRequest {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
  metadata?: Record<string, unknown>;
}

export interface SandboxRuntimeExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs?: number;
  truncated?: boolean;
}

export interface SandboxRuntimeConnection {
  id: string;
  execute(request: SandboxRuntimeExecuteRequest): Promise<SandboxRuntimeExecuteResult>;
  uploadFiles(
    files: Array<{ path: string; content: Uint8Array }>,
  ): Promise<SandboxFileUploadResult[]>;
  downloadFiles(paths: string[]): Promise<SandboxFileDownloadResult[]>;
  listFiles(path: string): Promise<FileInfo[]>;
  statPath(path: string): Promise<FileInfo | undefined>;
  deletePaths(paths: string[]): Promise<void>;
  dispose?(): Promise<void>;
}

export interface SandboxSnapshotRecord {
  snapshotId: string;
  platform: string;
  createdAt: string;
  files: Array<{
    path: string;
    base64: string;
    modifiedAt?: string;
  }>;
  metadata?: Record<string, unknown>;
}

export interface SandboxSnapshotStore {
  save(record: SandboxSnapshotRecord): Promise<void>;
  load(snapshotId: string): Promise<SandboxSnapshotRecord | undefined>;
}

export interface SandboxInstance {
  id: string;
  platform: string;
  workspaceRoot: string;
  capabilities(): BackendCapabilities;
  exec(request: SandboxExecRequest): Promise<SandboxExecResult>;
  readFile(path: string): Promise<string>;
  readBinaryFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(path: string): Promise<FileInfo[]>;
  statPath(path: string): Promise<FileInfo | undefined>;
  createSession(options?: CreateSessionOptions): Promise<BackendSession>;
  closeSession(sessionId: string): Promise<void>;
  captureSnapshot(snapshotId: string): Promise<SandboxSnapshotRecord>;
  restoreSnapshot(record: SandboxSnapshotRecord): Promise<void>;
  dispose(): Promise<void>;
}

export interface SandboxPlatform {
  kind: string;
  create(lease: SandboxLease): Promise<SandboxInstance>;
}

export interface SandboxPlatformRegistry {
  register(platform: SandboxPlatform): void;
  get(kind: string): SandboxPlatform | undefined;
  list(): SandboxPlatform[];
}

export interface SandboxManagerOptions {
  registry: SandboxPlatformRegistry;
  snapshotStore: SandboxSnapshotStore;
  defaultPolicy?: Partial<SandboxCommandPolicy>;
}

export interface SandboxManager {
  capabilitiesFor(lease: SandboxLease): Promise<BackendCapabilities>;
  exec(lease: SandboxLease, request: SandboxExecRequest): Promise<SandboxExecResult>;
  readFile(lease: SandboxLease, path: string): Promise<string>;
  readBinaryFile(lease: SandboxLease, path: string): Promise<Uint8Array>;
  writeFile(lease: SandboxLease, path: string, content: string): Promise<void>;
  listFiles(lease: SandboxLease, path: string): Promise<FileInfo[]>;
  statPath(lease: SandboxLease, path: string): Promise<FileInfo | undefined>;
  createSession(lease: SandboxLease, options?: CreateSessionOptions): Promise<BackendSession>;
  closeSession(lease: SandboxLease, sessionId: string): Promise<void>;
  captureSnapshot(lease: SandboxLease, snapshotId: string): Promise<SandboxSnapshotRecord>;
  restoreSnapshot(lease: SandboxLease, snapshotId: string): Promise<void>;
  disposeLease(lease: SandboxLease): Promise<void>;
}

export interface SandboxBackendOptions {
  manager: SandboxManager;
  lease: SandboxLease;
}

export interface SandboxExecutionBackend extends ExecutionBackend {
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  readBinaryFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(path: string): Promise<FileInfo[]>;
  statPath(path: string): Promise<FileInfo | undefined>;
  createSession(options?: CreateSessionOptions): Promise<BackendSession>;
  closeSession(sessionId: string): Promise<void>;
  captureSnapshot(snapshotId: string): Promise<SandboxSnapshotRecord>;
  restoreSnapshot(snapshotId: string): Promise<void>;
}

export interface SandboxBackendResolverOptions {
  localBackend?: ExecutionBackend;
  manager: SandboxManager;
  buildLease(ctx: AgentRunContext, tool: AgentTool, call: ToolCall): SandboxLease;
  shouldUseSandbox?(ctx: AgentRunContext, tool: AgentTool, call: ToolCall): boolean;
}

export interface SandboxResolver extends BackendResolver {}

export interface SandboxProvisionRequest {
  provider: string;
  leaseId?: string;
  sandboxId?: string;
  platform?: string;
  workspaceRoot?: string;
  mountPath?: string;
  snapshotId?: string;
  timeoutMs?: number;
  readinessTimeoutMs?: number;
  readinessIntervalMs?: number;
  policy?: Partial<SandboxCommandPolicy>;
  metadata?: Record<string, unknown>;
}

export interface SandboxDependencyCheckResult {
  ok: boolean;
  issues: string[];
}

export interface SandboxProviderDescriptor {
  kind: string;
  defaultWorkspaceRoot?: string;
  isolationMode?: SandboxIsolationMode;
  supportsReconnect?: boolean;
}

export interface SandboxProvider {
  kind: string;
  describe?(): SandboxProviderDescriptor;
  verifyDependencies?(): Promise<SandboxDependencyCheckResult> | SandboxDependencyCheckResult;
  initialize?(): Promise<void>;
  provision(request: SandboxProvisionRequest): Promise<SandboxLease>;
  prepare?(
    lease: SandboxLease,
    backend: SandboxExecutionBackend,
    request: SandboxProvisionRequest,
  ): Promise<void>;
  isReady?(
    lease: SandboxLease,
    backend: SandboxExecutionBackend,
    request: SandboxProvisionRequest,
  ): Promise<boolean> | boolean;
  release?(lease: SandboxLease): Promise<void>;
}

export interface SandboxProviderRuntimeState {
  kind: string;
  initialized: boolean;
  dependencyStatus: "unknown" | "ready" | "failed";
  issues: string[];
  descriptor?: SandboxProviderDescriptor;
  lastError?: string;
}

export interface SandboxFactoryHooks {
  beforeProvision?(request: SandboxProvisionRequest): Promise<void> | void;
  afterProvision?(
    lease: SandboxLease,
    request: SandboxProvisionRequest,
    backend: SandboxExecutionBackend,
  ): Promise<void> | void;
  onProvisionError?(
    error: unknown,
    request: SandboxProvisionRequest,
    lease?: SandboxLease,
  ): Promise<void> | void;
  beforeRelease?(lease: SandboxLease): Promise<void> | void;
  afterRelease?(lease: SandboxLease): Promise<void> | void;
  onReleaseError?(error: unknown, lease: SandboxLease): Promise<void> | void;
}

export interface SandboxFactoryOptions {
  manager: SandboxManager;
  hooks?: SandboxFactoryHooks;
  defaultProvisionTimeoutMs?: number;
  defaultReadinessTimeoutMs?: number;
  defaultReadinessIntervalMs?: number;
}

export interface ManagedSandboxBackendResolverOptions {
  factory: {
    provision(request: SandboxProvisionRequest): Promise<SandboxLease>;
    release(lease: SandboxLease): Promise<void>;
    createBackend(lease: SandboxLease): SandboxExecutionBackend;
  };
  provider: string;
  localBackend?: ExecutionBackend;
  leaseStore?: SandboxLeaseStore;
  buildRequest?(
    ctx: AgentRunContext,
    tool: AgentTool,
    call: ToolCall,
  ): Omit<SandboxProvisionRequest, "provider"> | Promise<Omit<SandboxProvisionRequest, "provider">>;
  shouldUseSandbox?(ctx: AgentRunContext, tool: AgentTool, call: ToolCall): boolean;
}

export interface SandboxLifecycleMiddlewareOptions {
  releaseRun(runId: string): Promise<void>;
}

export interface SandboxAgentIntegration {
  backend: BackendResolver;
  middleware: AgentMiddleware[];
}

export interface CreateSandboxAgentIntegrationOptions extends ManagedSandboxBackendResolverOptions {}

export interface ManagedSandboxLeaseRecord {
  runId: string;
  provider: string;
  lease: SandboxLease;
  createdAt: string;
  lastUsedAt: string;
}

export interface SandboxLeaseStore {
  save(record: ManagedSandboxLeaseRecord): Promise<void>;
  load(runId: string): Promise<ManagedSandboxLeaseRecord | undefined>;
  delete(runId: string): Promise<void>;
  list(): Promise<ManagedSandboxLeaseRecord[]>;
}

export interface SandboxLeaseJanitorOptions {
  factory: {
    release(lease: SandboxLease): Promise<void>;
    listActiveLeases(): SandboxLease[];
  };
  store: SandboxLeaseStore;
  staleAfterMs: number;
  now?: () => Date;
}

export interface SandboxLeaseJanitorReport {
  released: number;
  failed: number;
  failures: Array<{ runId: string; leaseId: string; message: string }>;
}

export interface SandboxDoctorOptions {
  factory: {
    listProviders(): SandboxProvider[];
    listProviderStates(): SandboxProviderRuntimeState[];
    listActiveLeases(): SandboxLease[];
  };
  leaseStore?: SandboxLeaseStore;
}

export interface SandboxDoctorProviderReport extends SandboxProviderRuntimeState {
  defaultWorkspaceRoot?: string;
  isolationMode?: SandboxIsolationMode;
  supportsReconnect?: boolean;
}

export interface SandboxDoctorDurableLeaseReport {
  runId: string;
  provider: string;
  leaseId: string;
  sandboxId?: string;
  platform: string;
  workspaceRoot: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface SandboxDoctorReport {
  providers: SandboxDoctorProviderReport[];
  activeLeases: SandboxLease[];
  durableLeases: SandboxDoctorDurableLeaseReport[];
  warnings: string[];
}

import type {
  BackendCapabilities,
  BackendSession,
  CreateSessionOptions,
  ExecOptions,
  ExecResult,
  FileInfo,
} from "@renx/agent";

import { SandboxLifecycleError } from "./errors";
import type {
  SandboxBackendOptions,
  SandboxExecutionBackend,
  SandboxSnapshotRecord,
} from "./types";

export class SandboxBackend implements SandboxExecutionBackend {
  readonly kind = "sandbox";
  private readonly negotiatedCapabilities: BackendCapabilities;

  constructor(private readonly options: SandboxBackendOptions) {
    if (!options.lease.capabilities) {
      throw new SandboxLifecycleError(
        `Sandbox backend requires negotiated capabilities for lease ${options.lease.leaseId}.`,
      );
    }
    this.negotiatedCapabilities = options.lease.capabilities;
  }

  capabilities(): BackendCapabilities {
    return this.negotiatedCapabilities;
  }

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    return await this.options.manager.exec(this.options.lease, {
      command,
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      ...(opts?.env ? { env: opts.env } : {}),
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}),
      ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts?.metadata ? { metadata: opts.metadata } : {}),
    });
  }

  async readFile(path: string): Promise<string> {
    return await this.options.manager.readFile(this.options.lease, path);
  }

  async readBinaryFile(path: string): Promise<Uint8Array> {
    return await this.options.manager.readBinaryFile(this.options.lease, path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.options.manager.writeFile(this.options.lease, path, content);
  }

  async listFiles(path: string): Promise<FileInfo[]> {
    return await this.options.manager.listFiles(this.options.lease, path);
  }

  async statPath(path: string): Promise<FileInfo | undefined> {
    return await this.options.manager.statPath(this.options.lease, path);
  }

  async createSession(options?: CreateSessionOptions): Promise<BackendSession> {
    return await this.options.manager.createSession(this.options.lease, options);
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.options.manager.closeSession(this.options.lease, sessionId);
  }

  async captureSnapshot(snapshotId: string): Promise<SandboxSnapshotRecord> {
    return await this.options.manager.captureSnapshot(this.options.lease, snapshotId);
  }

  async restoreSnapshot(snapshotId: string): Promise<void> {
    await this.options.manager.restoreSnapshot(this.options.lease, snapshotId);
  }
}

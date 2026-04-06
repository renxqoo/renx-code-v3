import type {
  BackendCapabilities,
  BackendSession,
  CreateSessionOptions,
  FileInfo,
} from "@renx/agent";

import { SandboxPlatformError, SandboxPolicyError } from "./errors";
import { isPathWithin } from "./path-utils";
import {
  assertSandboxExecPolicy,
  mergeSandboxPolicy,
  resolveSandboxPolicy,
  sanitizeSandboxEnvironment,
} from "./policy";
import type {
  SandboxCommandPolicy,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxInstance,
  SandboxLease,
  SandboxManager,
  SandboxManagerOptions,
  SandboxSnapshotRecord,
} from "./types";

interface SandboxLeaseEntry {
  lease: SandboxLease;
  policy: SandboxCommandPolicy;
  instance: SandboxInstance;
}

export class DefaultSandboxManager implements SandboxManager {
  private readonly entries = new Map<string, Promise<SandboxLeaseEntry>>();

  constructor(private readonly options: SandboxManagerOptions) {}

  async capabilitiesFor(lease: SandboxLease): Promise<BackendCapabilities> {
    const entry = await this.getEntry(lease);
    return entry.instance.capabilities();
  }

  async exec(lease: SandboxLease, request: SandboxExecRequest): Promise<SandboxExecResult> {
    const entry = await this.getEntry(lease);
    assertSandboxExecPolicy(entry.policy, request);
    const sanitizedEnv = request.env
      ? sanitizeSandboxEnvironment(entry.policy, request.env)
      : undefined;
    return await entry.instance.exec({
      command: request.command,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
      ...(sanitizedEnv ? { env: sanitizedEnv } : {}),
      timeoutMs: Math.min(
        request.timeoutMs ?? entry.policy.maxExecutionTimeoutMs,
        entry.policy.maxExecutionTimeoutMs,
      ),
    });
  }

  async readFile(lease: SandboxLease, path: string): Promise<string> {
    const entry = await this.getEntry(lease);
    return await entry.instance.readFile(path);
  }

  async readBinaryFile(lease: SandboxLease, path: string): Promise<Uint8Array> {
    const entry = await this.getEntry(lease);
    return await entry.instance.readBinaryFile(path);
  }

  async writeFile(lease: SandboxLease, path: string, content: string): Promise<void> {
    const entry = await this.getEntry(lease);
    this.assertWriteAllowed(entry.policy, lease, path);
    await entry.instance.writeFile(path, content);
  }

  async listFiles(lease: SandboxLease, path: string): Promise<FileInfo[]> {
    const entry = await this.getEntry(lease);
    return await entry.instance.listFiles(path);
  }

  async statPath(lease: SandboxLease, path: string): Promise<FileInfo | undefined> {
    const entry = await this.getEntry(lease);
    return await entry.instance.statPath(path);
  }

  async createSession(
    lease: SandboxLease,
    options?: CreateSessionOptions,
  ): Promise<BackendSession> {
    const entry = await this.getEntry(lease);
    return await entry.instance.createSession(options);
  }

  async closeSession(lease: SandboxLease, sessionId: string): Promise<void> {
    const entry = await this.getEntry(lease);
    await entry.instance.closeSession(sessionId);
  }

  async captureSnapshot(lease: SandboxLease, snapshotId: string): Promise<SandboxSnapshotRecord> {
    const entry = await this.getEntry(lease);
    const record = await entry.instance.captureSnapshot(snapshotId);
    await this.options.snapshotStore.save(record);
    return record;
  }

  async restoreSnapshot(lease: SandboxLease, snapshotId: string): Promise<void> {
    const entry = await this.getEntry(lease);
    const record = await this.options.snapshotStore.load(snapshotId);
    if (!record) {
      throw new SandboxPlatformError(`Sandbox snapshot not found: ${snapshotId}`);
    }
    if (record.platform !== lease.platform) {
      throw new SandboxPlatformError(
        `Sandbox snapshot platform mismatch: expected ${lease.platform}, received ${record.platform}`,
      );
    }
    await entry.instance.restoreSnapshot(record);
  }

  async disposeLease(lease: SandboxLease): Promise<void> {
    const pending = this.entries.get(lease.leaseId);
    if (!pending) return;
    this.entries.delete(lease.leaseId);
    const entry = await pending;
    await entry.instance.dispose();
  }

  private async getEntry(lease: SandboxLease): Promise<SandboxLeaseEntry> {
    const existing = this.entries.get(lease.leaseId);
    if (existing) {
      const entry = await existing;
      this.assertLeaseIdentity(entry.lease, lease);
      return entry;
    }

    const created = this.createEntry(lease);
    this.entries.set(lease.leaseId, created);

    try {
      return await created;
    } catch (error) {
      if (this.entries.get(lease.leaseId) === created) {
        this.entries.delete(lease.leaseId);
      }
      throw error;
    }
  }

  private async createEntry(lease: SandboxLease): Promise<SandboxLeaseEntry> {
    const platform = this.options.registry.get(lease.platform);
    if (!platform) {
      throw new SandboxPlatformError(`Sandbox platform not registered: ${lease.platform}`);
    }

    const policy = this.resolvePolicyForLease(lease);
    const instance = await platform.create(lease);

    if (lease.snapshotId) {
      const snapshot = await this.options.snapshotStore.load(lease.snapshotId);
      if (!snapshot) {
        throw new SandboxPlatformError(`Sandbox snapshot not found: ${lease.snapshotId}`);
      }
      if (snapshot.platform !== lease.platform) {
        throw new SandboxPlatformError(
          `Sandbox snapshot platform mismatch: expected ${lease.platform}, received ${snapshot.platform}`,
        );
      }
      await instance.restoreSnapshot(snapshot);
    }

    return {
      lease: { ...lease },
      policy,
      instance,
    };
  }

  private resolvePolicyForLease(lease: SandboxLease): SandboxCommandPolicy {
    const merged = mergeSandboxPolicy(this.options.defaultPolicy, lease.policy);
    const policy = resolveSandboxPolicy(merged);
    if (policy.allowedWriteRoots.length > 0) {
      return policy;
    }
    return {
      ...policy,
      allowedWriteRoots: [lease.workspaceRoot],
    };
  }

  private assertWriteAllowed(
    policy: SandboxCommandPolicy,
    lease: SandboxLease,
    path: string,
  ): void {
    const candidatePath = isPathWithin(lease.workspaceRoot, path)
      ? path
      : `${lease.workspaceRoot.replace(/[\\/]+$/, "")}/${path.replace(/^[\\/]+/, "")}`;
    const allowedRoots =
      policy.allowedWriteRoots.length > 0 ? policy.allowedWriteRoots : [lease.workspaceRoot];
    const permitted = allowedRoots.some((root) => isPathWithin(root, candidatePath));
    if (!permitted) {
      throw new SandboxPolicyError(`Sandbox policy blocked file write: ${path}`);
    }
  }

  private assertLeaseIdentity(original: SandboxLease, next: SandboxLease): void {
    if (
      original.platform !== next.platform ||
      original.workspaceRoot !== next.workspaceRoot ||
      original.mountPath !== next.mountPath
    ) {
      throw new SandboxPlatformError(
        `Sandbox lease ${next.leaseId} was reused with incompatible configuration.`,
      );
    }
  }
}

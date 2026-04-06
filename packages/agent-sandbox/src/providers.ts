import { createSandboxId } from "./path-utils";
import type {
  SandboxDependencyCheckResult,
  SandboxProviderDescriptor,
  SandboxExecutionBackend,
  SandboxLease,
  SandboxProvisionRequest,
  SandboxProvider,
} from "./types";

export interface CallbackSandboxProviderOptions {
  kind: string;
  describe?(): SandboxProviderDescriptor;
  verifyDependencies?(): Promise<SandboxDependencyCheckResult> | SandboxDependencyCheckResult;
  initialize?(): Promise<void> | void;
  provision(request: SandboxProvisionRequest): Promise<SandboxLease> | SandboxLease;
  prepare?(
    lease: SandboxLease,
    backend: SandboxExecutionBackend,
    request: SandboxProvisionRequest,
  ): Promise<void> | void;
  isReady?(
    lease: SandboxLease,
    backend: SandboxExecutionBackend,
    request: SandboxProvisionRequest,
  ): Promise<boolean> | boolean;
  release?(lease: SandboxLease): Promise<void> | void;
}

export class CallbackSandboxProvider implements SandboxProvider {
  readonly kind: string;

  private readonly onDescribe: CallbackSandboxProviderOptions["describe"];
  private readonly onVerifyDependencies: CallbackSandboxProviderOptions["verifyDependencies"];
  private readonly onInitialize: CallbackSandboxProviderOptions["initialize"];
  private readonly onProvision: CallbackSandboxProviderOptions["provision"];
  private readonly onPrepare: CallbackSandboxProviderOptions["prepare"];
  private readonly onIsReady: CallbackSandboxProviderOptions["isReady"];
  private readonly onRelease: CallbackSandboxProviderOptions["release"];

  constructor(options: CallbackSandboxProviderOptions) {
    this.kind = options.kind;
    this.onDescribe = options.describe;
    this.onVerifyDependencies = options.verifyDependencies;
    this.onInitialize = options.initialize;
    this.onProvision = options.provision;
    this.onPrepare = options.prepare;
    this.onIsReady = options.isReady;
    this.onRelease = options.release;
  }

  describe(): SandboxProviderDescriptor {
    return this.onDescribe?.() ?? { kind: this.kind };
  }

  async verifyDependencies(): Promise<SandboxDependencyCheckResult> {
    return (await this.onVerifyDependencies?.()) ?? { ok: true, issues: [] };
  }

  async initialize(): Promise<void> {
    await this.onInitialize?.();
  }

  async provision(request: SandboxProvisionRequest): Promise<SandboxLease> {
    return await this.onProvision(request);
  }

  async prepare(
    lease: SandboxLease,
    backend: SandboxExecutionBackend,
    request: SandboxProvisionRequest,
  ): Promise<void> {
    await this.onPrepare?.(lease, backend, request);
  }

  async isReady(
    lease: SandboxLease,
    backend: SandboxExecutionBackend,
    request: SandboxProvisionRequest,
  ): Promise<boolean> {
    return (await this.onIsReady?.(lease, backend, request)) ?? true;
  }

  async release(lease: SandboxLease): Promise<void> {
    await this.onRelease?.(lease);
  }
}

export class LocalSandboxProvider implements SandboxProvider {
  readonly kind = "local";

  describe(): SandboxProviderDescriptor {
    return {
      kind: this.kind,
      defaultWorkspaceRoot: process.cwd(),
      isolationMode: "host",
      supportsReconnect: true,
    };
  }

  async verifyDependencies(): Promise<SandboxDependencyCheckResult> {
    return { ok: true, issues: [] };
  }

  async provision(request: SandboxProvisionRequest): Promise<SandboxLease> {
    return {
      leaseId: request.leaseId ?? createSandboxId("lease"),
      provider: this.kind,
      platform: request.platform ?? "local",
      workspaceRoot: request.workspaceRoot ?? process.cwd(),
      ...((request.sandboxId ?? request.leaseId)
        ? { sandboxId: request.sandboxId ?? request.leaseId }
        : {}),
      ...(request.mountPath ? { mountPath: request.mountPath } : {}),
      ...(request.snapshotId ? { snapshotId: request.snapshotId } : {}),
      ...(request.policy ? { policy: request.policy } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };
  }
}

export class InMemorySandboxProvider implements SandboxProvider {
  readonly kind = "memory";

  describe(): SandboxProviderDescriptor {
    return {
      kind: this.kind,
      defaultWorkspaceRoot: "/workspace",
      isolationMode: "memory",
      supportsReconnect: false,
    };
  }

  async verifyDependencies(): Promise<SandboxDependencyCheckResult> {
    return { ok: true, issues: [] };
  }

  async provision(request: SandboxProvisionRequest): Promise<SandboxLease> {
    return {
      leaseId: request.leaseId ?? createSandboxId("lease"),
      provider: this.kind,
      platform: request.platform ?? "memory",
      workspaceRoot: request.workspaceRoot ?? "/workspace",
      ...(request.sandboxId ? { sandboxId: request.sandboxId } : {}),
      ...(request.mountPath ? { mountPath: request.mountPath } : {}),
      ...(request.snapshotId ? { snapshotId: request.snapshotId } : {}),
      ...(request.policy ? { policy: request.policy } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };
  }
}

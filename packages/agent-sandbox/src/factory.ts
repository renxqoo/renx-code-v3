import { SandboxBackend } from "./backend";
import { SandboxLifecycleError, SandboxProviderError } from "./errors";
import type {
  SandboxFactoryOptions,
  SandboxLease,
  SandboxProviderRuntimeState,
  SandboxProvider,
  SandboxProvisionRequest,
} from "./types";

const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const DEFAULT_READINESS_INTERVAL_MS = 250;

export class SandboxFactory {
  private readonly providers = new Map<string, SandboxProvider>();
  private readonly leaseProviders = new Map<string, string>();
  private readonly activeLeases = new Map<string, SandboxLease>();
  private readonly initializedProviders = new Set<string>();
  private readonly providerStates = new Map<string, SandboxProviderRuntimeState>();

  constructor(private readonly options: SandboxFactoryOptions) {}

  registerProvider(provider: SandboxProvider): void {
    this.providers.set(provider.kind, provider);
    const descriptor = provider.describe?.();
    this.providerStates.set(provider.kind, {
      kind: provider.kind,
      initialized: false,
      dependencyStatus: "unknown",
      issues: [],
      ...(descriptor ? { descriptor } : {}),
    });
  }

  getProvider(kind: string): SandboxProvider | undefined {
    return this.providers.get(kind);
  }

  listProviders(): SandboxProvider[] {
    return [...this.providers.values()];
  }

  listActiveLeases(): SandboxLease[] {
    return [...this.activeLeases.values()];
  }

  listProviderStates(): SandboxProviderRuntimeState[] {
    return this.listProviders().map((provider) => {
      const descriptor = provider.describe?.();
      const existing = this.providerStates.get(provider.kind);
      const resolvedDescriptor = descriptor ?? existing?.descriptor;
      return {
        kind: provider.kind,
        initialized: existing?.initialized ?? false,
        dependencyStatus: existing?.dependencyStatus ?? "unknown",
        issues: [...(existing?.issues ?? [])],
        ...(resolvedDescriptor ? { descriptor: resolvedDescriptor } : {}),
        ...(existing?.lastError ? { lastError: existing.lastError } : {}),
      };
    });
  }

  async provision(request: SandboxProvisionRequest): Promise<SandboxLease> {
    return (await this.provisionInternal(request)).lease;
  }

  createBackend(lease: SandboxLease): SandboxBackend {
    return new SandboxBackend({
      manager: this.options.manager,
      lease,
    });
  }

  async provisionBackend(
    request: SandboxProvisionRequest,
  ): Promise<{ lease: SandboxLease; backend: SandboxBackend }> {
    return await this.provisionInternal(request);
  }

  async release(lease: SandboxLease): Promise<void> {
    await this.options.hooks?.beforeRelease?.(lease);
    let releaseError: unknown;
    try {
      await this.releaseLease(lease);
    } catch (error) {
      releaseError = error;
      try {
        await this.options.hooks?.onReleaseError?.(error, lease);
      } catch {
        // Diagnostics hooks must not hide the original release failure.
      }
      throw new SandboxLifecycleError(
        `Failed to release sandbox lease ${lease.leaseId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      try {
        await this.options.hooks?.afterRelease?.(lease);
      } catch (hookError) {
        if (!releaseError) {
          throw new SandboxLifecycleError(
            `Sandbox release hook failed for ${lease.leaseId}: ${hookError instanceof Error ? hookError.message : String(hookError)}`,
          );
        }
      }
    }
  }

  private async provisionInternal(
    request: SandboxProvisionRequest,
  ): Promise<{ lease: SandboxLease; backend: SandboxBackend }> {
    const provider = this.providers.get(request.provider);
    if (!provider) {
      throw new SandboxProviderError(`Sandbox provider not registered: ${request.provider}`);
    }

    const resolvedRequest = this.resolveRequestDefaults(provider, request);
    await this.ensureInitialized(provider);
    await this.options.hooks?.beforeProvision?.(resolvedRequest);

    const timeoutMs = this.resolveProvisionTimeoutMs(resolvedRequest);

    let lease: SandboxLease | undefined;
    try {
      lease = this.decorateLease(
        await withTimeout(
          () => provider.provision(resolvedRequest),
          timeoutMs,
          `Sandbox provision timed out for provider ${provider.kind}`,
        ),
        provider.kind,
        resolvedRequest,
      );
      this.leaseProviders.set(lease.leaseId, provider.kind);
      const negotiatedLease = {
        ...lease,
        capabilities: await withTimeout(
          () => this.options.manager.capabilitiesFor(lease!),
          timeoutMs,
          `Sandbox capability negotiation timed out for lease ${lease.leaseId}`,
        ),
      };
      const backend = this.createBackend(negotiatedLease);
      if (provider.prepare) {
        await withTimeout(
          () => provider.prepare!(negotiatedLease, backend, resolvedRequest),
          timeoutMs,
          `Sandbox preparation timed out for lease ${negotiatedLease.leaseId}`,
        );
      }
      await this.waitUntilReady(provider, negotiatedLease, backend, resolvedRequest);
      this.activeLeases.set(negotiatedLease.leaseId, negotiatedLease);
      await this.options.hooks?.afterProvision?.(negotiatedLease, resolvedRequest, backend);
      return { lease: negotiatedLease, backend };
    } catch (error) {
      try {
        await this.options.hooks?.onProvisionError?.(error, resolvedRequest, lease);
      } catch {
        // Diagnostics hooks must not hide the original provision failure.
      }
      if (lease) {
        await this.cleanupFailedProvision(provider, lease);
      }
      throw error;
    }
  }

  private async ensureInitialized(provider: SandboxProvider): Promise<void> {
    if (this.initializedProviders.has(provider.kind)) {
      return;
    }
    await this.ensureDependencies(provider);
    try {
      await provider.initialize?.();
      this.updateProviderState(provider.kind, {
        initialized: true,
        dependencyStatus: "ready",
        issues: [],
      });
    } catch (error) {
      this.updateProviderState(provider.kind, {
        dependencyStatus: "failed",
        issues: [error instanceof Error ? error.message : String(error)],
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw new SandboxProviderError(
        `Sandbox provider initialization failed for ${provider.kind}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.initializedProviders.add(provider.kind);
  }

  private async cleanupFailedProvision(
    provider: SandboxProvider,
    lease: SandboxLease,
  ): Promise<void> {
    this.activeLeases.delete(lease.leaseId);
    try {
      await this.options.manager.disposeLease(lease);
    } finally {
      try {
        await provider.release?.(lease);
      } finally {
        this.leaseProviders.delete(lease.leaseId);
      }
    }
  }

  private async releaseLease(lease: SandboxLease): Promise<void> {
    const providerKind = this.leaseProviders.get(lease.leaseId) ?? lease.provider;
    const provider = providerKind ? this.providers.get(providerKind) : undefined;
    this.activeLeases.delete(lease.leaseId);
    try {
      await this.options.manager.disposeLease(lease);
    } finally {
      try {
        await provider?.release?.(lease);
      } finally {
        this.leaseProviders.delete(lease.leaseId);
      }
    }
  }

  private async ensureDependencies(provider: SandboxProvider): Promise<void> {
    const current = this.providerStates.get(provider.kind);
    if (current?.dependencyStatus === "ready") {
      return;
    }
    if (current?.dependencyStatus === "failed") {
      throw new SandboxProviderError(
        `Sandbox provider dependency check failed for ${provider.kind}: ${current.issues.join(", ")}`,
      );
    }
    if (!provider.verifyDependencies) {
      this.updateProviderState(provider.kind, {
        dependencyStatus: "ready",
        issues: [],
      });
      return;
    }

    try {
      const result = await provider.verifyDependencies();
      if (!result.ok) {
        this.updateProviderState(provider.kind, {
          dependencyStatus: "failed",
          issues: [...result.issues],
          lastError: result.issues.join(", "),
        });
        throw new SandboxProviderError(
          `Sandbox provider dependency check failed for ${provider.kind}: ${result.issues.join(", ")}`,
        );
      }
      this.updateProviderState(provider.kind, {
        dependencyStatus: "ready",
        issues: [],
      });
    } catch (error) {
      if (error instanceof SandboxProviderError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.updateProviderState(provider.kind, {
        dependencyStatus: "failed",
        issues: [message],
        lastError: message,
      });
      throw new SandboxProviderError(
        `Sandbox provider dependency check failed for ${provider.kind}: ${message}`,
      );
    }
  }

  private resolveRequestDefaults(
    provider: SandboxProvider,
    request: SandboxProvisionRequest,
  ): SandboxProvisionRequest {
    const descriptor = provider.describe?.();
    return {
      ...request,
      ...(request.workspaceRoot
        ? {}
        : descriptor?.defaultWorkspaceRoot
          ? { workspaceRoot: descriptor.defaultWorkspaceRoot }
          : {}),
    };
  }

  private decorateLease(
    lease: SandboxLease,
    providerKind: string,
    request: SandboxProvisionRequest,
  ): SandboxLease {
    return {
      ...lease,
      provider: lease.provider ?? providerKind,
      ...(lease.sandboxId !== undefined
        ? {}
        : request.sandboxId !== undefined
          ? { sandboxId: request.sandboxId }
          : {}),
      createdAt: lease.createdAt ?? new Date().toISOString(),
    };
  }

  private resolveProvisionTimeoutMs(request: SandboxProvisionRequest): number | undefined {
    return request.timeoutMs ?? this.options.defaultProvisionTimeoutMs;
  }

  private async waitUntilReady(
    provider: SandboxProvider,
    lease: SandboxLease,
    backend: SandboxBackend,
    request: SandboxProvisionRequest,
  ): Promise<void> {
    if (!provider.isReady) {
      return;
    }

    const timeoutMs = request.readinessTimeoutMs ?? this.options.defaultReadinessTimeoutMs;
    const intervalMs = request.readinessIntervalMs ?? this.options.defaultReadinessIntervalMs;
    const timeout = timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    const interval = Math.max(1, intervalMs ?? DEFAULT_READINESS_INTERVAL_MS);
    const deadline = Date.now() + timeout;

    while (true) {
      const ready = await provider.isReady(lease, backend, request);
      if (ready) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new SandboxLifecycleError(
          `Sandbox provider readiness timed out for lease ${lease.leaseId} after ${timeout}ms`,
        );
      }
      await sleep(interval);
    }
  }

  private updateProviderState(kind: string, patch: Partial<SandboxProviderRuntimeState>): void {
    const existing = this.providerStates.get(kind);
    this.providerStates.set(kind, {
      kind,
      initialized: patch.initialized ?? existing?.initialized ?? false,
      dependencyStatus: patch.dependencyStatus ?? existing?.dependencyStatus ?? "unknown",
      issues: patch.issues ? [...patch.issues] : [...(existing?.issues ?? [])],
      ...(() => {
        const descriptor = patch.descriptor ?? existing?.descriptor;
        return descriptor ? { descriptor } : {};
      })(),
      ...(() => {
        const lastError = patch.lastError ?? existing?.lastError;
        return lastError ? { lastError } : {};
      })(),
    });
  }
}

const withTimeout = async <T>(
  operation: () => Promise<T>,
  timeoutMs: number | undefined,
  message: string,
): Promise<T> => {
  if (!timeoutMs || timeoutMs <= 0) {
    return await operation();
  }

  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new SandboxLifecycleError(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

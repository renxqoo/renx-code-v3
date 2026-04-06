import { SandboxProviderError } from "../../errors";
import type { SandboxExecutionBackend, SandboxLease, SandboxProvisionRequest } from "../../types";
import { quoteForPosixShell } from "./shell-command";

export const ensureProvisionPlatform = (
  request: SandboxProvisionRequest,
  platform: string,
  providerLabel: string,
): void => {
  if (request.platform && request.platform !== platform) {
    throw new SandboxProviderError(
      `${providerLabel} only provisions ${platform} platform leases, received ${request.platform}.`,
    );
  }
};

export const ensureAbsolutePosixWorkspaceRoot = (workspaceRoot: string, label: string): void => {
  if (!workspaceRoot.startsWith("/")) {
    throw new SandboxProviderError(
      `${label} workspaceRoot must be an absolute POSIX path, received ${workspaceRoot}.`,
    );
  }
};

const buildMergedMetadata = (
  requestMetadata: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  const merged = {
    ...(requestMetadata ?? {}),
    ...(metadata ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
};

export interface BuildSandboxLeaseOptions {
  provider: string;
  platform: string;
  leaseId: string;
  sandboxId?: string;
  workspaceRoot: string;
  mountPath?: string;
  request: SandboxProvisionRequest;
  metadata?: Record<string, unknown>;
}

export const buildSandboxLease = (options: BuildSandboxLeaseOptions): SandboxLease => {
  const metadata = buildMergedMetadata(options.request.metadata, options.metadata);

  return {
    leaseId: options.leaseId,
    provider: options.provider,
    ...(options.sandboxId ? { sandboxId: options.sandboxId } : {}),
    platform: options.platform,
    workspaceRoot: options.workspaceRoot,
    ...((options.mountPath ?? options.request.mountPath)
      ? { mountPath: options.mountPath ?? options.request.mountPath }
      : {}),
    ...(options.request.snapshotId ? { snapshotId: options.request.snapshotId } : {}),
    ...(options.request.policy ? { policy: options.request.policy } : {}),
    ...(metadata ? { metadata } : {}),
  };
};

export const prepareSandboxWorkspace = async (
  backend: SandboxExecutionBackend,
  workspaceRoot: string,
): Promise<void> => {
  await backend.exec(`mkdir -p ${quoteForPosixShell(workspaceRoot)}`);
};

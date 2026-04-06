import type { SandboxLease } from "../../types";

const readMetadataString = (
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined =>
  metadata && typeof metadata[key] === "string" ? (metadata[key] as string) : undefined;

const compactMetadata = (metadata: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));

export interface KubernetesLeaseMetadata {
  image?: string;
  namespace?: string;
  podName?: string;
  containerName?: string;
}

export const buildKubernetesLeaseMetadata = (
  metadata: KubernetesLeaseMetadata,
): Record<string, unknown> =>
  compactMetadata({
    ...(metadata.image ? { image: metadata.image } : {}),
    ...(metadata.namespace ? { namespace: metadata.namespace } : {}),
    ...(metadata.podName ? { podName: metadata.podName } : {}),
    ...(metadata.containerName ? { containerName: metadata.containerName } : {}),
  });

export const resolveKubernetesLeaseTarget = (
  lease: SandboxLease,
  defaults: {
    namespace?: string;
    containerName?: string;
  } = {},
): {
  namespace?: string;
  podName?: string;
  containerName?: string;
} => {
  const namespace = readMetadataString(lease.metadata, "namespace") ?? defaults.namespace;
  const podName = readMetadataString(lease.metadata, "podName") ?? lease.sandboxId;
  const containerName =
    readMetadataString(lease.metadata, "containerName") ?? defaults.containerName;

  return {
    ...(namespace ? { namespace } : {}),
    ...(podName ? { podName } : {}),
    ...(containerName ? { containerName } : {}),
  };
};

export interface RemoteLeaseMetadata {
  sandboxBaseUrl: string;
}

export const buildRemoteLeaseMetadata = (
  metadata: RemoteLeaseMetadata,
): Record<string, unknown> => ({
  sandboxBaseUrl: metadata.sandboxBaseUrl,
});

export const resolveRemoteSandboxBaseUrl = (
  lease: SandboxLease,
  defaultBaseUrl?: string,
): string | undefined => readMetadataString(lease.metadata, "sandboxBaseUrl") ?? defaultBaseUrl;

export interface DaytonaLeaseMetadata {
  sandboxName?: string;
  requestedName?: string;
}

export const buildDaytonaLeaseMetadata = (
  metadata: DaytonaLeaseMetadata,
): Record<string, unknown> =>
  compactMetadata({
    ...(metadata.sandboxName ? { sandboxName: metadata.sandboxName } : {}),
    ...(metadata.requestedName ? { requestedName: metadata.requestedName } : {}),
  });

export const resolveDaytonaSandboxReference = (
  lease: SandboxLease,
): {
  sandboxId?: string;
  sandboxName?: string;
  requestedName?: string;
} => {
  const sandboxName = readMetadataString(lease.metadata, "sandboxName");
  const requestedName = readMetadataString(lease.metadata, "requestedName");

  return {
    ...(lease.sandboxId ? { sandboxId: lease.sandboxId } : {}),
    ...(sandboxName ? { sandboxName } : {}),
    ...(requestedName ? { requestedName } : {}),
  };
};

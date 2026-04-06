import { SandboxProviderError } from "../../errors";

export type KubernetesImagePullPolicy = "Always" | "IfNotPresent" | "Never";

export interface KubernetesSandboxPodSpecOptions {
  podName: string;
  namespace: string;
  image: string;
  workspaceRoot: string;
  allowNetwork: boolean;
  leaseId: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  env?: Record<string, string>;
  imagePullPolicy?: KubernetesImagePullPolicy;
  serviceAccountName?: string;
  mountPath?: string;
  allowHostPathMounts?: boolean;
  idleCommand?: string;
  containerName?: string;
}

const DEFAULT_IDLE_COMMAND = "while true; do sleep 3600; done";

export const buildKubernetesSandboxPodManifest = (
  options: KubernetesSandboxPodSpecOptions,
): Record<string, unknown> => {
  assertAbsolutePosixPath(options.workspaceRoot, "workspaceRoot");

  const containerName = options.containerName ?? "workspace";
  const idleCommand = options.idleCommand ?? DEFAULT_IDLE_COMMAND;
  const workspaceVolume = options.mountPath
    ? buildHostPathWorkspaceVolume(options.mountPath, options.allowHostPathMounts)
    : { name: "workspace", emptyDir: {} };

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: options.podName,
      namespace: options.namespace,
      labels: {
        "renx.sandbox.provider": "kubernetes",
        "renx.sandbox.lease": options.leaseId,
        "renx.sandbox.network": options.allowNetwork ? "allowed" : "blocked",
        ...(options.labels ?? {}),
      },
      ...(options.annotations
        ? {
            annotations: {
              ...options.annotations,
            },
          }
        : {}),
    },
    spec: {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      restartPolicy: "Never",
      ...(options.serviceAccountName ? { serviceAccountName: options.serviceAccountName } : {}),
      securityContext: {
        seccompProfile: {
          type: "RuntimeDefault",
        },
      },
      containers: [
        {
          name: containerName,
          image: options.image,
          imagePullPolicy: options.imagePullPolicy ?? "IfNotPresent",
          workingDir: options.workspaceRoot,
          command: ["sh", "-lc", idleCommand],
          ...(options.env
            ? {
                env: Object.entries(options.env).map(([name, value]) => ({
                  name,
                  value,
                })),
              }
            : {}),
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: false,
            runAsNonRoot: true,
            capabilities: {
              drop: ["ALL"],
            },
          },
          volumeMounts: [
            {
              name: "workspace",
              mountPath: options.workspaceRoot,
            },
          ],
        },
      ],
      volumes: [workspaceVolume],
    },
  };
};

const buildHostPathWorkspaceVolume = (
  mountPath: string,
  allowHostPathMounts: boolean | undefined,
): Record<string, unknown> => {
  if (!allowHostPathMounts) {
    throw new SandboxProviderError(
      `Kubernetes sandbox hostPath mounts are disabled by default. Rejecting host path ${mountPath}.`,
    );
  }
  return {
    name: "workspace",
    hostPath: {
      path: mountPath,
      type: "DirectoryOrCreate",
    },
  };
};

const assertAbsolutePosixPath = (value: string, label: string): void => {
  if (!value.startsWith("/")) {
    throw new SandboxProviderError(
      `Kubernetes sandbox ${label} must be an absolute POSIX path, received ${value}.`,
    );
  }
};

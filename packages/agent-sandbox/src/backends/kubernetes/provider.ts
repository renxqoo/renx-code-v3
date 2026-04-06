import { SandboxProviderError } from "../../errors";
import { createSandboxId } from "../../path-utils";
import type {
  SandboxDependencyCheckResult,
  SandboxExecutionBackend,
  SandboxLease,
  SandboxProvisionRequest,
  SandboxProvider,
  SandboxProviderDescriptor,
} from "../../types";
import {
  buildKubernetesLeaseMetadata,
  resolveKubernetesLeaseTarget,
} from "../shared/lease-metadata";
import { reconcileManagedResource } from "../shared/managed-resource";
import {
  buildSandboxLease,
  ensureAbsolutePosixWorkspaceRoot,
  ensureProvisionPlatform,
  prepareSandboxWorkspace,
} from "../shared/provider-helpers";
import { KubectlSandboxClient } from "./client";
import type { KubectlCommandRunner } from "./cli";
import type { KubernetesImagePullPolicy } from "./pod-spec";
import { buildKubernetesSandboxPodManifest } from "./pod-spec";

export interface KubernetesSandboxProviderOptions {
  kind?: string;
  image?: string;
  namespace?: string;
  workspaceRoot?: string;
  command?: string;
  runner?: KubectlCommandRunner;
  context?: string;
  kubeconfigPath?: string;
  imagePullPolicy?: KubernetesImagePullPolicy;
  serviceAccountName?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  environment?: Record<string, string>;
  idleCommand?: string;
  allowHostPathMounts?: boolean;
}

const DEFAULT_IMAGE = "node:20-bookworm-slim";
const DEFAULT_NAMESPACE = "default";
const DEFAULT_WORKSPACE_ROOT = "/workspace";
const DEFAULT_CONTAINER_NAME = "workspace";

export class KubernetesSandboxProvider implements SandboxProvider {
  readonly kind: string;

  private readonly image: string;
  private readonly namespace: string;
  private readonly workspaceRoot: string;
  private readonly imagePullPolicy: KubernetesImagePullPolicy | undefined;
  private readonly serviceAccountName: string | undefined;
  private readonly labels: Record<string, string>;
  private readonly annotations: Record<string, string>;
  private readonly environment: Record<string, string>;
  private readonly idleCommand: string | undefined;
  private readonly allowHostPathMounts: boolean;
  private readonly client: KubectlSandboxClient;

  constructor(options: KubernetesSandboxProviderOptions = {}) {
    this.kind = options.kind ?? "kubernetes";
    this.image = options.image ?? DEFAULT_IMAGE;
    this.namespace = options.namespace ?? DEFAULT_NAMESPACE;
    this.workspaceRoot = options.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
    this.imagePullPolicy = options.imagePullPolicy;
    this.serviceAccountName = options.serviceAccountName;
    this.labels = { ...(options.labels ?? {}) };
    this.annotations = { ...(options.annotations ?? {}) };
    this.environment = { ...(options.environment ?? {}) };
    this.idleCommand = options.idleCommand;
    this.allowHostPathMounts = options.allowHostPathMounts ?? false;
    this.client = new KubectlSandboxClient({
      ...(options.command ? { command: options.command } : {}),
      ...(options.runner ? { runner: options.runner } : {}),
      ...(options.namespace ? { namespace: options.namespace } : {}),
      ...(options.context ? { context: options.context } : {}),
      ...(options.kubeconfigPath ? { kubeconfigPath: options.kubeconfigPath } : {}),
    });
  }

  describe(): SandboxProviderDescriptor {
    return {
      kind: this.kind,
      defaultWorkspaceRoot: this.workspaceRoot,
      isolationMode: "container",
      supportsReconnect: true,
    };
  }

  async verifyDependencies(): Promise<SandboxDependencyCheckResult> {
    try {
      const result = await this.client.version();
      if (result.exitCode === 0) {
        return { ok: true, issues: [] };
      }
      return {
        ok: false,
        issues: ["kubectl cli is unavailable"],
      };
    } catch (error) {
      return {
        ok: false,
        issues: [
          `kubectl cli is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  async provision(request: SandboxProvisionRequest): Promise<SandboxLease> {
    ensureProvisionPlatform(request, "kubernetes", "Kubernetes sandbox provider");

    const workspaceRoot = request.workspaceRoot ?? this.workspaceRoot;
    ensureAbsolutePosixWorkspaceRoot(workspaceRoot, "Kubernetes sandbox");
    if (request.mountPath && !this.allowHostPathMounts) {
      throw new SandboxProviderError(
        `Kubernetes sandbox hostPath mounts are disabled by default. Rejecting host path ${request.mountPath}.`,
      );
    }

    const namespace = this.resolveNamespace(request);
    const leaseId = request.leaseId ?? createSandboxId("lease");
    const podName = request.sandboxId ?? createSandboxId("sandbox");

    const pod = await this.client.getPod(podName, namespace);
    const reconciled = await reconcileManagedResource({
      resource: pod.exists ? pod : undefined,
      classify: (resource) =>
        resource.phase === "Failed" || resource.phase === "Succeeded" ? "replace" : "reuse",
      replace: async () => {
        await this.client.deletePod(podName, namespace);
      },
    });

    if (!reconciled) {
      const manifest = buildKubernetesSandboxPodManifest({
        podName,
        namespace,
        image: this.image,
        workspaceRoot,
        allowNetwork: request.policy?.allowNetwork ?? false,
        leaseId,
        labels: this.labels,
        annotations: this.annotations,
        env: this.environment,
        ...(this.imagePullPolicy ? { imagePullPolicy: this.imagePullPolicy } : {}),
        ...(this.serviceAccountName ? { serviceAccountName: this.serviceAccountName } : {}),
        ...(request.mountPath ? { mountPath: request.mountPath } : {}),
        ...(this.idleCommand ? { idleCommand: this.idleCommand } : {}),
        allowHostPathMounts: this.allowHostPathMounts,
        containerName: DEFAULT_CONTAINER_NAME,
      });
      await this.client.applyManifest(manifest);
    }

    return buildSandboxLease({
      provider: this.kind,
      platform: "kubernetes",
      leaseId,
      sandboxId: podName,
      workspaceRoot,
      request,
      metadata: buildKubernetesLeaseMetadata({
        image: this.image,
        namespace,
        podName,
        containerName: DEFAULT_CONTAINER_NAME,
      }),
    });
  }

  async prepare(lease: SandboxLease, backend: SandboxExecutionBackend): Promise<void> {
    await prepareSandboxWorkspace(backend, lease.workspaceRoot);
  }

  async isReady(lease: SandboxLease): Promise<boolean> {
    const target = resolveKubernetesLeaseTarget(lease, {
      namespace: this.namespace,
      containerName: DEFAULT_CONTAINER_NAME,
    });
    if (!target.podName) {
      return false;
    }
    const pod = await this.client.getPod(target.podName, target.namespace);
    return pod.exists && pod.phase === "Running" && pod.ready === true;
  }

  async release(lease: SandboxLease): Promise<void> {
    const target = resolveKubernetesLeaseTarget(lease, {
      namespace: this.namespace,
      containerName: DEFAULT_CONTAINER_NAME,
    });
    if (!target.podName) {
      return;
    }
    await this.client.deletePod(target.podName, target.namespace);
  }

  private resolveNamespace(request: SandboxProvisionRequest): string {
    const metadataNamespace =
      request.metadata && typeof request.metadata.namespace === "string"
        ? request.metadata.namespace
        : undefined;
    return metadataNamespace ?? this.namespace;
  }
}

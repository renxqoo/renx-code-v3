import { SandboxPlatformError } from "../../errors";
import type { SandboxLease, SandboxRuntimeConnection } from "../../types";
import { ConnectionSandboxPlatform } from "../../platform/connection-platform";
import { createCommandRuntimeConnection } from "../shared/command-runtime-connection";
import { resolveKubernetesLeaseTarget } from "../shared/lease-metadata";
import { buildPosixShellCommand } from "../shared/shell-command";
import { KubectlSandboxClient } from "./client";
import type { KubectlCommandRunner } from "./cli";
import { decodeKubectlBytes } from "./cli";

export interface KubernetesSandboxPlatformOptions {
  command?: string;
  runner?: KubectlCommandRunner;
  namespace?: string;
  context?: string;
  kubeconfigPath?: string;
  shell?: string;
  containerName?: string;
}

export class KubernetesSandboxPlatform extends ConnectionSandboxPlatform {
  readonly kind = "kubernetes";

  private readonly client: KubectlSandboxClient;
  private readonly shell: string;
  private readonly namespace: string | undefined;
  private readonly containerName: string | undefined;

  constructor(options: KubernetesSandboxPlatformOptions = {}) {
    super();
    this.client = new KubectlSandboxClient({
      ...(options.command ? { command: options.command } : {}),
      ...(options.runner ? { runner: options.runner } : {}),
      ...(options.namespace ? { namespace: options.namespace } : {}),
      ...(options.context ? { context: options.context } : {}),
      ...(options.kubeconfigPath ? { kubeconfigPath: options.kubeconfigPath } : {}),
    });
    this.shell = options.shell ?? "sh";
    this.namespace = options.namespace;
    this.containerName = options.containerName;
  }

  protected async connect(lease: SandboxLease): Promise<SandboxRuntimeConnection> {
    const target = resolveKubernetesLeaseTarget(lease, {
      ...(this.namespace ? { namespace: this.namespace } : {}),
      ...(this.containerName ? { containerName: this.containerName } : {}),
    });
    if (!target.podName) {
      throw new SandboxPlatformError(
        `Kubernetes sandbox lease ${lease.leaseId} is missing sandboxId or metadata.podName.`,
      );
    }

    return createCommandRuntimeConnection({
      id: `kubernetes:${target.namespace ?? "default"}/${target.podName}`,
      invoke: async (request) =>
        await this.client.exec({
          podName: target.podName!,
          ...(target.namespace ? { namespace: target.namespace } : {}),
          ...(target.containerName ? { containerName: target.containerName } : {}),
          args: request.args,
          ...(request.stdin ? { stdin: request.stdin } : {}),
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        }),
      buildExecuteArgs: (request) => [
        this.shell,
        "-lc",
        buildPosixShellCommand(request.command, {
          ...(request.cwd ? { cwd: request.cwd } : {}),
          ...(request.env ? { env: request.env } : {}),
        }),
      ],
      buildNodeArgs: (request) => ["node", "-e", request.script, ...(request.args ?? [])],
      decode: decodeKubectlBytes,
    });
  }
}

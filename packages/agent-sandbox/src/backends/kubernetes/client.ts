import { SandboxProviderError } from "../../errors";
import { createKubectlCommandRunner, decodeKubectlBytes } from "./cli";
import { throwSandboxSurfaceError } from "../shared/surface-errors";
import type { KubectlCommandResult, KubectlCommandRunner } from "./cli";

export interface KubernetesPodState {
  exists: boolean;
  phase?: string;
  ready?: boolean;
  manifest?: Record<string, unknown>;
}

export interface KubectlSandboxClientOptions {
  command?: string;
  runner?: KubectlCommandRunner;
  namespace?: string;
  context?: string;
  kubeconfigPath?: string;
}

export class KubectlSandboxClient {
  private readonly runner: KubectlCommandRunner;
  private readonly namespace: string | undefined;
  private readonly context: string | undefined;
  private readonly kubeconfigPath: string | undefined;

  constructor(options: KubectlSandboxClientOptions = {}) {
    this.runner =
      options.runner ??
      createKubectlCommandRunner(options.command ? { command: options.command } : {});
    this.namespace = options.namespace;
    this.context = options.context;
    this.kubeconfigPath = options.kubeconfigPath;
  }

  async version(): Promise<KubectlCommandResult> {
    return await this.run(["version", "--client=true", "-o", "json"], "provider");
  }

  async getPod(name: string, namespace?: string): Promise<KubernetesPodState> {
    const resolvedNamespace = namespace ?? this.namespace;
    const result = await this.run(
      ["get", "pod", name, ...this.namespaceArgs(resolvedNamespace), "-o", "json"],
      "provider",
      { allowFailure: true },
    );
    if (result.exitCode !== 0) {
      return { exists: false };
    }

    let manifest: {
      status?: {
        phase?: string;
        conditions?: Array<{ type?: string; status?: string }>;
      };
    };
    try {
      manifest = JSON.parse(decodeKubectlBytes(result.stdout)) as {
        status?: {
          phase?: string;
          conditions?: Array<{ type?: string; status?: string }>;
        };
      };
    } catch (error) {
      throw new SandboxProviderError(
        `Failed to parse kubectl pod response for ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const readyCondition = manifest.status?.conditions?.find(
      (condition) => condition.type === "Ready",
    );
    return {
      exists: true,
      ...(manifest.status?.phase ? { phase: manifest.status.phase } : {}),
      ...(readyCondition ? { ready: readyCondition.status === "True" } : {}),
      manifest: manifest as Record<string, unknown>,
    };
  }

  async applyManifest(manifest: Record<string, unknown>): Promise<void> {
    const namespace =
      typeof manifest.metadata === "object" &&
      manifest.metadata !== null &&
      "namespace" in manifest.metadata &&
      typeof manifest.metadata.namespace === "string"
        ? manifest.metadata.namespace
        : this.namespace;

    const result = await this.run(
      ["apply", ...this.namespaceArgs(namespace), "-f", "-"],
      "provider",
      {
        stdin: Uint8Array.from(Buffer.from(JSON.stringify(manifest), "utf8")),
      },
    );
    if (result.exitCode !== 0) {
      throw new SandboxProviderError(
        `Failed to apply kubernetes manifest: ${decodeKubectlBytes(result.stderr).trim() || "unknown kubectl error"}`,
      );
    }
  }

  async deletePod(name: string, namespace?: string): Promise<void> {
    const result = await this.run(
      [
        "delete",
        "pod",
        name,
        ...this.namespaceArgs(namespace ?? this.namespace),
        "--ignore-not-found=true",
        "--wait=false",
      ],
      "provider",
      { allowFailure: true },
    );
    if (result.exitCode !== 0) {
      throw new SandboxProviderError(
        `Failed to delete kubernetes pod ${name}: ${decodeKubectlBytes(result.stderr).trim() || "unknown kubectl error"}`,
      );
    }
  }

  async exec(request: {
    podName: string;
    namespace?: string;
    containerName?: string;
    args: string[];
    stdin?: Uint8Array;
    timeoutMs?: number;
  }): Promise<KubectlCommandResult> {
    return await this.run(
      [
        "exec",
        ...(request.stdin ? ["-i"] : []),
        ...this.namespaceArgs(request.namespace ?? this.namespace),
        request.podName,
        ...(request.containerName ? ["-c", request.containerName] : []),
        "--",
        ...request.args,
      ],
      "platform",
      {
        ...(request.stdin ? { stdin: request.stdin } : {}),
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      },
    );
  }

  private contextArgs(): string[] {
    return [
      ...(this.context ? ["--context", this.context] : []),
      ...(this.kubeconfigPath ? ["--kubeconfig", this.kubeconfigPath] : []),
    ];
  }

  private namespaceArgs(namespace?: string): string[] {
    return namespace ? ["-n", namespace] : [];
  }

  private async run(
    args: string[],
    surface: "provider" | "platform",
    request: {
      stdin?: Uint8Array;
      timeoutMs?: number;
      allowFailure?: boolean;
    } = {},
  ): Promise<KubectlCommandResult> {
    try {
      return await this.runner({
        args: [...args.slice(0, 1), ...this.contextArgs(), ...args.slice(1)],
        ...(request.stdin ? { stdin: request.stdin } : {}),
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return throwSandboxSurfaceError(surface, `Kubectl command failed: ${message}`);
    }
  }
}

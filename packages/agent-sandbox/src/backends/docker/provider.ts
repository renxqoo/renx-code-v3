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
import { reconcileManagedResource } from "../shared/managed-resource";
import {
  buildSandboxLease,
  ensureAbsolutePosixWorkspaceRoot,
  ensureProvisionPlatform,
  prepareSandboxWorkspace,
} from "../shared/provider-helpers";
import { createDockerCommandRunner, decodeDockerBytes } from "./cli";
import type { DockerCommandResult, DockerCommandRunner } from "./cli";

export type DockerImagePullPolicy = "always" | "if-not-present" | "never";

export interface DockerSandboxProviderOptions {
  kind?: string;
  image?: string;
  workspaceRoot?: string;
  command?: string;
  runner?: DockerCommandRunner;
  pullPolicy?: DockerImagePullPolicy;
  environment?: Record<string, string>;
  labels?: Record<string, string>;
  extraRunArgs?: string[];
  idleCommand?: string;
}

const DEFAULT_DOCKER_IMAGE = "node:20-bookworm-slim";
const DEFAULT_DOCKER_WORKSPACE_ROOT = "/workspace";
const DEFAULT_IDLE_COMMAND = "while true; do sleep 3600; done";

export class DockerSandboxProvider implements SandboxProvider {
  readonly kind: string;

  private readonly runner: DockerCommandRunner;
  private readonly image: string;
  private readonly workspaceRoot: string;
  private readonly pullPolicy: DockerImagePullPolicy;
  private readonly environment: Record<string, string>;
  private readonly labels: Record<string, string>;
  private readonly extraRunArgs: string[];
  private readonly idleCommand: string;

  constructor(options: DockerSandboxProviderOptions = {}) {
    this.kind = options.kind ?? "docker";
    this.runner =
      options.runner ??
      createDockerCommandRunner(options.command ? { command: options.command } : {});
    this.image = options.image ?? DEFAULT_DOCKER_IMAGE;
    this.workspaceRoot = options.workspaceRoot ?? DEFAULT_DOCKER_WORKSPACE_ROOT;
    this.pullPolicy = options.pullPolicy ?? "if-not-present";
    this.environment = { ...(options.environment ?? {}) };
    this.labels = { ...(options.labels ?? {}) };
    this.extraRunArgs = [...(options.extraRunArgs ?? [])];
    this.idleCommand = options.idleCommand ?? DEFAULT_IDLE_COMMAND;
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
      const result = await this.runner({
        args: ["version"],
      });
      if (result.exitCode === 0) {
        return { ok: true, issues: [] };
      }
      const issue = decodeDockerBytes(result.stderr).trim() || "docker cli is unavailable";
      return { ok: false, issues: [issue] };
    } catch (error) {
      return {
        ok: false,
        issues: [
          `docker cli is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  async initialize(): Promise<void> {
    if (this.pullPolicy === "never") {
      return;
    }

    if (this.pullPolicy === "always") {
      await this.pullImage();
      return;
    }

    const inspectResult = await this.runDocker(["image", "inspect", this.image]);
    if (inspectResult.exitCode !== 0) {
      await this.pullImage();
    }
  }

  async provision(request: SandboxProvisionRequest): Promise<SandboxLease> {
    ensureProvisionPlatform(request, "docker", "Docker sandbox provider");

    const workspaceRoot = request.workspaceRoot ?? this.workspaceRoot;
    ensureAbsolutePosixWorkspaceRoot(workspaceRoot, "Docker sandbox");

    const leaseId = request.leaseId ?? createSandboxId("lease");
    const sandboxId = request.sandboxId ?? createSandboxId("sandbox");

    const existingState = await this.inspectContainerState(sandboxId);
    const reconciled = await reconcileManagedResource({
      resource: existingState === "missing" ? undefined : existingState,
      classify: (state) => (state === "running" ? "reuse" : "resume"),
      resume: async () => {
        await this.ensureDockerSuccess(
          await this.runDocker(["start", sandboxId]),
          `Failed to start docker sandbox ${sandboxId}.`,
        );
        return "running" as const;
      },
    });

    if (!reconciled) {
      await this.createContainer({
        sandboxId,
        leaseId,
        workspaceRoot,
        request,
      });
    }

    return buildSandboxLease({
      provider: this.kind,
      platform: "docker",
      leaseId,
      sandboxId,
      workspaceRoot,
      request,
      metadata: {
        image: this.image,
      },
    });
  }

  async prepare(lease: SandboxLease, backend: SandboxExecutionBackend): Promise<void> {
    await prepareSandboxWorkspace(backend, lease.workspaceRoot);
  }

  async release(lease: SandboxLease): Promise<void> {
    if (!lease.sandboxId) {
      return;
    }

    const result = await this.runDocker(["rm", "-f", lease.sandboxId]);
    if (result.exitCode !== 0 && !/no such container/i.test(decodeDockerBytes(result.stderr))) {
      throw new SandboxProviderError(
        `Failed to remove docker sandbox ${lease.sandboxId}: ${decodeDockerBytes(result.stderr).trim() || "unknown docker error"}`,
      );
    }
  }

  private async createContainer(input: {
    sandboxId: string;
    leaseId: string;
    workspaceRoot: string;
    request: SandboxProvisionRequest;
  }): Promise<void> {
    const args = [
      "run",
      "-d",
      "--name",
      input.sandboxId,
      "--workdir",
      input.workspaceRoot,
      ...(!input.request.policy?.allowNetwork ? ["--network", "none"] : []),
      ...Object.entries({
        "renx.sandbox.provider": this.kind,
        "renx.sandbox.lease": input.leaseId,
        ...this.labels,
      }).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      ...Object.entries(this.environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      ...(input.request.mountPath
        ? ["-v", `${input.request.mountPath}:${input.workspaceRoot}`]
        : []),
      ...this.extraRunArgs,
      this.image,
      "sh",
      "-lc",
      this.idleCommand,
    ];

    await this.ensureDockerSuccess(
      await this.runDocker(args),
      `Failed to create docker sandbox ${input.sandboxId}.`,
    );
  }

  private async pullImage(): Promise<void> {
    await this.ensureDockerSuccess(
      await this.runDocker(["pull", this.image]),
      `Failed to pull docker image ${this.image}.`,
    );
  }

  private async inspectContainerState(
    sandboxId: string,
  ): Promise<"running" | "stopped" | "missing"> {
    const result = await this.runDocker([
      "inspect",
      "--format",
      "{{json .State.Running}}",
      sandboxId,
    ]);
    if (result.exitCode !== 0) {
      return "missing";
    }

    const raw = decodeDockerBytes(result.stdout).trim();
    return raw === "true" ? "running" : "stopped";
  }

  private async runDocker(args: string[]): Promise<DockerCommandResult> {
    try {
      return await this.runner({ args });
    } catch (error) {
      throw new SandboxProviderError(
        `Docker command failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async ensureDockerSuccess(result: DockerCommandResult, message: string): Promise<void> {
    if (result.exitCode === 0) {
      return;
    }
    throw new SandboxProviderError(
      `${message} ${decodeDockerBytes(result.stderr).trim() || "unknown docker error"}`.trim(),
    );
  }
}

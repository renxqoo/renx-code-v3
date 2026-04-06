import { SandboxPlatformError } from "../../errors";
import type { SandboxLease, SandboxRuntimeConnection } from "../../types";
import { ConnectionSandboxPlatform } from "../../platform/connection-platform";
import { createCommandRuntimeConnection } from "../shared/command-runtime-connection";
import { createDockerCommandRunner, decodeDockerBytes } from "./cli";
import type { DockerCommandResult, DockerCommandRunner } from "./cli";

export interface DockerSandboxPlatformOptions {
  command?: string;
  runner?: DockerCommandRunner;
  shell?: string;
}

export class DockerSandboxPlatform extends ConnectionSandboxPlatform {
  readonly kind = "docker";
  private readonly runner: DockerCommandRunner;
  private readonly shell: string;

  constructor(options: DockerSandboxPlatformOptions = {}) {
    super();
    this.runner =
      options.runner ??
      createDockerCommandRunner(options.command ? { command: options.command } : {});
    this.shell = options.shell ?? "sh";
  }

  protected async connect(lease: SandboxLease): Promise<SandboxRuntimeConnection> {
    if (!lease.sandboxId) {
      throw new SandboxPlatformError(`Docker sandbox lease ${lease.leaseId} is missing sandboxId.`);
    }

    const runDocker = async (
      args: string[],
      request: {
        stdin?: Uint8Array;
        timeoutMs?: number;
      } = {},
    ): Promise<DockerCommandResult> => {
      try {
        return await this.runner({
          args,
          ...(request.stdin ? { stdin: request.stdin } : {}),
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        });
      } catch (error) {
        throw new SandboxPlatformError(
          `Docker command failed for sandbox ${lease.sandboxId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    const shellArgs = (
      command: string,
      request: {
        cwd?: string;
        env?: Record<string, string>;
        stdin?: Uint8Array;
      } = {},
    ): string[] => [
      "exec",
      ...(request.stdin ? ["-i"] : []),
      ...(request.cwd ? ["--workdir", request.cwd] : []),
      ...Object.entries(request.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      lease.sandboxId!,
      this.shell,
      "-lc",
      command,
    ];

    return createCommandRuntimeConnection({
      id: `docker:${lease.sandboxId}`,
      invoke: async (request) =>
        await runDocker(request.args, {
          ...(request.stdin ? { stdin: request.stdin } : {}),
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        }),
      buildExecuteArgs: (request) =>
        shellArgs(request.command, {
          ...(request.cwd ? { cwd: request.cwd } : {}),
          ...(request.env ? { env: request.env } : {}),
          ...(request.stdin ? { stdin: request.stdin } : {}),
        }),
      buildNodeArgs: (request) => [
        "exec",
        ...(request.stdin ? ["-i"] : []),
        lease.sandboxId!,
        "node",
        "-e",
        request.script,
        ...(request.args ?? []),
      ],
      decode: decodeDockerBytes,
    });
  }
}

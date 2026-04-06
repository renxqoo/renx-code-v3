import type { SandboxRuntimeConnection, SandboxRuntimeExecuteRequest } from "../../types";
import { createNodeRuntimeConnection } from "./node-runtime-connection";
import type { BinaryCommandResult } from "./process-runner";
import { decodeBinaryCommandBytes } from "./process-runner";

export interface CommandRuntimeInvokeRequest {
  args: string[];
  stdin?: Uint8Array;
  timeoutMs?: number;
}

export interface CommandRuntimeConnectionOptions<
  TResult extends BinaryCommandResult = BinaryCommandResult,
> {
  id: string;
  invoke(request: CommandRuntimeInvokeRequest): Promise<TResult>;
  buildExecuteArgs(request: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    stdin?: Uint8Array;
    metadata?: Record<string, unknown>;
  }): string[];
  buildNodeArgs(request: { script: string; args?: string[]; stdin?: Uint8Array }): string[];
  decode?(value: Uint8Array): string;
}

const toUtf8Bytes = (value: string | undefined): Uint8Array | undefined =>
  value !== undefined ? Uint8Array.from(Buffer.from(value, "utf8")) : undefined;

export const createCommandRuntimeConnection = <
  TResult extends BinaryCommandResult = BinaryCommandResult,
>(
  options: CommandRuntimeConnectionOptions<TResult>,
): SandboxRuntimeConnection => {
  const decode = options.decode ?? decodeBinaryCommandBytes;

  return createNodeRuntimeConnection({
    id: options.id,
    execute: async (request: SandboxRuntimeExecuteRequest) => {
      const stdin = toUtf8Bytes(request.stdin);
      const result = await options.invoke({
        args: options.buildExecuteArgs({
          command: request.command,
          ...(request.cwd ? { cwd: request.cwd } : {}),
          ...(request.env ? { env: request.env } : {}),
          ...(stdin ? { stdin } : {}),
          ...(request.metadata ? { metadata: request.metadata } : {}),
        }),
        ...(stdin ? { stdin } : {}),
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      });

      return {
        stdout: decode(result.stdout),
        stderr: decode(result.stderr),
        exitCode: result.exitCode,
        ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
      };
    },
    runNode: async (request) =>
      await options.invoke({
        args: options.buildNodeArgs({
          script: request.script,
          ...(request.args ? { args: request.args } : {}),
          ...(request.stdin ? { stdin: request.stdin } : {}),
        }),
        ...(request.stdin ? { stdin: request.stdin } : {}),
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      }),
    decode,
  });
};

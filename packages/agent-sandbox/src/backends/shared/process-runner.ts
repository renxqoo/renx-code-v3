import { spawn } from "node:child_process";

export interface BinaryCommandRequest {
  args: string[];
  stdin?: Uint8Array;
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface BinaryCommandResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number;
  durationMs?: number;
}

export type BinaryCommandRunner = (request: BinaryCommandRequest) => Promise<BinaryCommandResult>;

export interface BinaryCommandRunnerOptions {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

export const createBinaryCommandRunner = (
  options: BinaryCommandRunnerOptions,
): BinaryCommandRunner => {
  return async (request: BinaryCommandRequest): Promise<BinaryCommandResult> => {
    const startedAt = Date.now();
    return await new Promise<BinaryCommandResult>((resolve, reject) => {
      const child = spawn(options.command, request.args, {
        cwd: request.cwd ?? options.cwd,
        env: {
          ...process.env,
          ...(options.env ?? {}),
          ...(request.env ?? {}),
        },
        stdio: "pipe",
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      let settled = false;

      const finish = (result: BinaryCommandResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const timeoutHandle =
        request.timeoutMs && request.timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, request.timeoutMs)
          : undefined;

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutChunks.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(Buffer.from(chunk));
      });

      child.on("error", (error) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        fail(error);
      });

      child.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        finish({
          stdout: Uint8Array.from(Buffer.concat(stdoutChunks)),
          stderr: Uint8Array.from(
            Buffer.concat(
              timedOut
                ? [...stderrChunks, Buffer.from("Command timed out.", "utf8")]
                : stderrChunks,
            ),
          ),
          exitCode: timedOut ? 124 : (code ?? 1),
          durationMs: Date.now() - startedAt,
        });
      });

      if (request.stdin) {
        child.stdin.write(Buffer.from(request.stdin));
      }
      child.stdin.end();
    });
  };
};

export const decodeBinaryCommandBytes = (value: Uint8Array): string =>
  Buffer.from(value).toString("utf8");

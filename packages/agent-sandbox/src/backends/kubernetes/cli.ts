import { createBinaryCommandRunner, decodeBinaryCommandBytes } from "../shared/process-runner";
import type {
  BinaryCommandRequest,
  BinaryCommandResult,
  BinaryCommandRunner,
  BinaryCommandRunnerOptions,
} from "../shared/process-runner";

export type KubectlCommandRequest = BinaryCommandRequest;
export type KubectlCommandResult = BinaryCommandResult;
export type KubectlCommandRunner = BinaryCommandRunner;

export interface KubectlCommandRunnerOptions extends Omit<BinaryCommandRunnerOptions, "command"> {
  command?: string;
}

export const createKubectlCommandRunner = (
  options: KubectlCommandRunnerOptions = {},
): KubectlCommandRunner =>
  createBinaryCommandRunner({
    command: options.command ?? "kubectl",
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
  });

export const decodeKubectlBytes = decodeBinaryCommandBytes;

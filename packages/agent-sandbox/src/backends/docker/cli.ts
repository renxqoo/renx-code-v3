import { createBinaryCommandRunner, decodeBinaryCommandBytes } from "../shared/process-runner";
import type {
  BinaryCommandRequest,
  BinaryCommandResult,
  BinaryCommandRunner,
  BinaryCommandRunnerOptions,
} from "../shared/process-runner";

export type DockerCommandRequest = BinaryCommandRequest;
export type DockerCommandResult = BinaryCommandResult;
export type DockerCommandRunner = BinaryCommandRunner;

export interface DockerCommandRunnerOptions extends Omit<BinaryCommandRunnerOptions, "command"> {
  command?: string;
}

export const createDockerCommandRunner = (
  options: DockerCommandRunnerOptions = {},
): DockerCommandRunner =>
  createBinaryCommandRunner({
    command: options.command ?? "docker",
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
  });

export const decodeDockerBytes = decodeBinaryCommandBytes;

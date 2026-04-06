import type { AgentTool } from "@renx/agent";

import { createBashTool } from "../bash/bash-tool";

import { createFileEditTool } from "./file-edit-tool";
import { createFileReadTool, type CreateFileReadToolOptions } from "./file-read-tool";
import { createFileWriteTool } from "./file-write-tool";
import { createGitStatusTool } from "./git-status-tool";
import { createGlobTool, type CreateGlobToolOptions } from "./glob-tool";
import { createGrepTool, type CreateGrepToolOptions } from "./grep-tool";
import { createRunChecksTool } from "./run-checks-tool";

export interface CreateCodingToolsetOptions {
  fileRead?: CreateFileReadToolOptions;
  glob?: CreateGlobToolOptions;
  grep?: CreateGrepToolOptions;
  bashDescription?: string;
}

export const createCodingToolset = (options?: CreateCodingToolsetOptions): AgentTool[] => [
  createFileReadTool(options?.fileRead),
  createFileWriteTool(),
  createFileEditTool(),
  createGlobTool(options?.glob),
  createGrepTool(options?.grep),
  createGitStatusTool(),
  createRunChecksTool(),
  createBashTool({
    description:
      options?.bashDescription ??
      "Execute shell commands for repository inspection, targeted tests, build, lint, and debugging within the current workspace.",
  }),
];

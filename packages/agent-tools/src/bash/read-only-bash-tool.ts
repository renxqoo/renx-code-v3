import type { AgentTool, ToolResult } from "@renx/agent";
import { z } from "zod";

import { createBashTool, type CreateBashToolOptions } from "./bash-tool";
import { assessBashCommand, mergeBashSecurityConfig } from "./security";

const readOnlyBashInputSchema = z.object({
  command: z.string().min(1),
});

export const DEFAULT_READ_ONLY_BASH_ALLOWED_PREFIXES = [
  "ls",
  "dir",
  "pwd",
  "cd",
  "Get-Location",
  "Get-ChildItem",
  "cat",
  "type",
  "head",
  "tail",
  "more",
  "less",
  "git status",
  "git diff",
  "git log",
  "git show",
  "find",
  "grep",
  "rg",
  "Select-String",
] as const;

export interface WrapReadOnlyBashToolOptions {
  description?: string;
  allowedCommandPrefixes?: readonly string[];
}

export interface CreateReadOnlyBashToolOptions extends CreateBashToolOptions {
  allowedCommandPrefixes?: readonly string[];
}

const buildVerdict = (command: string, allowedCommandPrefixes: readonly string[]) =>
  assessBashCommand(
    command,
    mergeBashSecurityConfig({
      allowedCommandPrefixes: [...allowedCommandPrefixes],
    }),
  );

export const wrapBashToolReadOnly = (
  tool: AgentTool,
  options?: WrapReadOnlyBashToolOptions,
): AgentTool => {
  const allowedCommandPrefixes =
    options?.allowedCommandPrefixes ?? DEFAULT_READ_ONLY_BASH_ALLOWED_PREFIXES;

  return {
    ...tool,
    ...(options?.description ? { description: options.description } : {}),
    isReadOnly: () => true,
    invoke: async (input, ctx): Promise<ToolResult> => {
      const parsed = readOnlyBashInputSchema.safeParse(input);
      if (!parsed.success) {
        return await tool.invoke(input, ctx);
      }

      const verdict = buildVerdict(parsed.data.command, allowedCommandPrefixes);
      if (!verdict.ok) {
        return {
          content: `[${verdict.code}] ${verdict.message}`,
          metadata: {
            tool: tool.name,
            blocked: true,
            code: verdict.code,
          },
        };
      }

      return await tool.invoke(input, ctx);
    },
  };
};

export const createReadOnlyBashTool = (options?: CreateReadOnlyBashToolOptions): AgentTool =>
  wrapBashToolReadOnly(createBashTool(options), {
    ...(options?.description ? { description: options.description } : {}),
    ...(options?.allowedCommandPrefixes
      ? { allowedCommandPrefixes: options.allowedCommandPrefixes }
      : {}),
  });

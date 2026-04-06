import type { AgentTool, ToolResult } from "@renx/agent";
import { createToolCapabilityProfile } from "@renx/agent";
import { z } from "zod";

import {
  collectWorkspaceFiles,
  globToRegExp,
  resolveWorkspacePath,
  toWorkspaceRelativePath,
} from "./shared";

export interface CreateGlobToolOptions {
  maxResults?: number;
}

const GLOB_TOOL_DESCRIPTION = `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead`;

export const createGlobTool = (options?: CreateGlobToolOptions): AgentTool => {
  const schema = z.object({
    pattern: z.string().min(1),
    path: z.string().optional(),
  });

  return {
    name: "Glob",
    description: GLOB_TOOL_DESCRIPTION,
    schema,
    capabilities: ["requires-filesystem-read"],
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["filesystem_read", "search"],
      sandboxExpectation: "read-only",
      auditCategory: "search",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    invoke: async (input, ctx): Promise<ToolResult> => {
      const parsed = schema.parse(input);
      const searchRoot = await resolveWorkspacePath(ctx, parsed.path ?? ".");
      const regex = globToRegExp(parsed.pattern);
      const files = await collectWorkspaceFiles(ctx, searchRoot.workspaceRoot, searchRoot.fullPath);
      const matches = files
        .filter((file) => regex.test(toWorkspaceRelativePath(searchRoot.fullPath, file.fullPath)))
        .map((file) => ({
          path: toWorkspaceRelativePath(searchRoot.workspaceRoot, file.fullPath),
          mtimeMs: file.mtimeMs ?? 0,
        }))
        .sort((left, right) => right.mtimeMs - left.mtimeMs)
        .map((entry) => entry.path);
      const maxResults = Math.max(1, options?.maxResults ?? 200);
      const truncated = matches.length > maxResults;
      const visible = truncated ? matches.slice(0, maxResults) : matches;

      return {
        content: [
          ...visible,
          ...(truncated
            ? ["(Results truncated. Narrow the pattern or path to see more files.)"]
            : []),
        ].join("\n"),
        structured: {
          files: visible,
          total: matches.length,
          truncated,
        },
      };
    },
  };
};

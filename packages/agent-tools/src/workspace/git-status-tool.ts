import type { AgentTool, ToolResult } from "@renx/agent";
import { createToolCapabilityProfile } from "@renx/agent";
import { z } from "zod";

import { getWorkspaceRoot } from "./shared";

const GIT_STATUS_TOOL_PROMPT = `Show git status for the current workspace. Use this when you need a quick repo dirtiness snapshot before editing, committing, or summarizing changes. This tool should stay read-only and only inspect repository status.`;

export const createGitStatusTool = (): AgentTool => {
  const schema = z.object({}).passthrough();
  return {
    name: "git_status",
    description: GIT_STATUS_TOOL_PROMPT,
    schema,
    capabilities: ["requires-exec"],
    profile: createToolCapabilityProfile({
      riskLevel: "medium",
      capabilityTags: ["process_exec", "git"],
      sandboxExpectation: "workspace-write",
      auditCategory: "git",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    invoke: async (_input, ctx): Promise<ToolResult> => {
      if (!ctx.backend?.exec) {
        throw new Error("No execution backend is available for git_status.");
      }
      const result = await ctx.backend.exec("git status --short", {
        cwd: getWorkspaceRoot(ctx),
        timeoutMs: 30_000,
      });
      return {
        content: result.stdout || result.stderr || `exit_code: ${result.exitCode}`,
        structured: result,
      };
    },
  };
};

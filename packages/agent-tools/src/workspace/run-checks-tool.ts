import type { AgentTool, ToolResult } from "@renx/agent";
import { createToolCapabilityProfile } from "@renx/agent";
import { z } from "zod";

import { getRepoCommand, getWorkspaceRoot } from "./shared";

const RUN_CHECKS_TOOL_PROMPT = `Run repo-aware verification commands such as tests, lint, build, or typecheck. Prefer preset-based verification when the repository already exposes known commands through repo facts. Use a custom command only when the preset is insufficient.`;

export const createRunChecksTool = (): AgentTool => {
  const schema = z.object({
    preset: z.enum(["test", "lint", "build", "typecheck", "auto"]).optional(),
    command: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
  });

  return {
    name: "run_checks",
    description: RUN_CHECKS_TOOL_PROMPT,
    schema,
    capabilities: ["requires-exec"],
    profile: createToolCapabilityProfile({
      riskLevel: "medium",
      capabilityTags: ["process_exec", "verification"],
      sandboxExpectation: "workspace-write",
      auditCategory: "verification",
    }),
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    invoke: async (input, ctx): Promise<ToolResult> => {
      if (!ctx.backend?.exec) {
        throw new Error("No execution backend is available for run_checks.");
      }
      const parsed = schema.parse(input);
      const command = parsed.command ?? getRepoCommand(ctx, parsed.preset);
      if (!command) {
        return { content: "No matching repo command was discovered for this preset." };
      }
      const result = await ctx.backend.exec(command, {
        cwd: getWorkspaceRoot(ctx),
        timeoutMs: parsed.timeoutMs ?? 120_000,
      });
      return {
        content: [result.stdout, result.stderr, `exit_code: ${result.exitCode}`]
          .filter((part) => part.length > 0)
          .join("\n\n"),
        structured: result,
      };
    },
  };
};

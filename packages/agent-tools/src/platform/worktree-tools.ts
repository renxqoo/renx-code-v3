import type { AgentTool } from "@renx/agent";
import { createToolCapabilityProfile } from "@renx/agent";
import { z } from "zod";

import { buildPlatformPatch, okToolResult } from "./shared";

const ENTER_WORKTREE_PROMPT = `Use this tool ONLY when the user explicitly asks to work in a worktree. This tool creates an isolated git worktree and switches the current session into it.

## When to Use

- The user explicitly says "worktree"

## When NOT to Use

- The user asks to create a branch, switch branches, or work on a different branch - use git commands instead
- The user asks to fix a bug or work on a feature - use normal git workflow unless they specifically mention worktrees
- Never use this tool unless the user explicitly mentions "worktree"

## Parameters

- \`name\` (optional): A name for the worktree. If not provided, a random name is generated.`;

const EXIT_WORKTREE_PROMPT = `Exit a worktree session created by EnterWorktree and return the session to the original working directory.

## When to Use

- The user explicitly asks to exit the worktree, leave the worktree, or go back
- Do NOT call this proactively - only when the user asks

## Parameters

- \`action\` (required): \`"keep"\` or \`"remove"\`
- \`discard_changes\` (optional): required confirmation when removing a dirty worktree`;

export const createEnterWorktreeTool = (): AgentTool => {
  const schema = z.object({
    name: z.string().min(1).optional(),
  });

  return {
    name: "EnterWorktree",
    description: ENTER_WORKTREE_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "medium",
      capabilityTags: ["workspace"],
      sandboxExpectation: "workspace-write",
      auditCategory: "workspace",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      const name = parsed.name ?? "worktree";
      return okToolResult(`Entered worktree ${name}.`, {
        statePatch: buildPlatformPatch(ctx, (state) => ({
          ...state,
          worktree: {
            active: true,
            path: name,
            branch: name,
          },
        })),
      });
    },
  };
};

export const createExitWorktreeTool = (): AgentTool => {
  const schema = z.object({
    action: z.enum(["keep", "remove"]),
    discard_changes: z.boolean().optional(),
  });

  return {
    name: "ExitWorktree",
    description: EXIT_WORKTREE_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["workspace"],
      sandboxExpectation: "read-only",
      auditCategory: "workspace",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      return okToolResult(`Exited worktree (${parsed.action}).`, {
        statePatch: buildPlatformPatch(ctx, (state) => ({
          ...state,
          worktree: { active: false },
        })),
      });
    },
  };
};

/**
 * {@link PolicyEngine} for bash-style commands: the **only** place that applies
 * {@link evaluatePermissionRules} in the agent path. Use `getPolicy()` with the same
 * `rules` you document for operators; `createBashTool` no longer duplicates this in `invoke`.
 */
import type { AgentRunContext, PolicyEngine } from "@renx/agent";
import type { AgentTool } from "@renx/agent";

import type { BashPermissionRules, BashPermissionVerdict } from "./permissions";
import { evaluatePermissionRules } from "./permissions";

export function bashVerdictToPolicySignals(verdict: BashPermissionVerdict): {
  canUseTool: boolean;
  needApproval: boolean;
} {
  if (verdict.ok) {
    return { canUseTool: true, needApproval: false };
  }
  if (verdict.effect === "deny") {
    return { canUseTool: false, needApproval: false };
  }
  return { canUseTool: true, needApproval: true };
}

function extractBashCommand(input: unknown): string | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const cmd = (input as Record<string, unknown>).command;
  if (typeof cmd !== "string") {
    return null;
  }
  const t = cmd.trim();
  if (t.length === 0) {
    return null;
  }
  return cmd;
}

export interface BashPermissionPolicyOptions {
  /** Tool names that carry `input.command` (default: `local_shell` and `bash`). */
  bashToolNames?: readonly string[];
  rules: BashPermissionRules;
}

export class BashPermissionPolicy implements PolicyEngine {
  private readonly names: ReadonlySet<string>;
  private readonly rules: BashPermissionRules;

  constructor(options: BashPermissionPolicyOptions) {
    this.rules = options.rules;
    this.names = new Set(
      options.bashToolNames?.length ? options.bashToolNames : ["local_shell", "bash"],
    );
  }

  filterTools(_ctx: AgentRunContext, tools: AgentTool[]): AgentTool[] {
    return tools;
  }

  canUseTool(_ctx: AgentRunContext, tool: AgentTool, input: unknown): boolean {
    if (!this.names.has(tool.name)) {
      return true;
    }
    const command = extractBashCommand(input);
    if (command === null) {
      return false;
    }
    const verdict = evaluatePermissionRules(command, this.rules);
    return bashVerdictToPolicySignals(verdict).canUseTool;
  }

  needApproval(_ctx: AgentRunContext, tool: AgentTool, input: unknown): boolean {
    if (!this.names.has(tool.name)) {
      return false;
    }
    const command = extractBashCommand(input);
    if (command === null) {
      return false;
    }
    const verdict = evaluatePermissionRules(command, this.rules);
    return bashVerdictToPolicySignals(verdict).needApproval;
  }
}

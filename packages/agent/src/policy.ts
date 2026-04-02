import type { AgentRunContext } from "./types";
import type { AgentTool } from "./tool/types";

import type { PolicyEngine } from "./types";
export type { PolicyEngine } from "./types";

/**
 * Default policy that allows everything.
 */
export class AllowAllPolicy implements PolicyEngine {
  filterTools(_ctx: AgentRunContext, tools: AgentTool[]): AgentTool[] {
    return tools;
  }

  canUseTool(_ctx: AgentRunContext, _tool: AgentTool, _input: unknown): boolean {
    return true;
  }
}

/**
 * Hides denied tools from the model and rejects any direct tool call that slips through
 * (defense in depth). Use tool names as registered on {@link AgentTool.name}.
 *
 * To block by a **command code inside tool arguments** (e.g. one tool with `input.cmd`):
 * implement a custom {@link PolicyEngine} and in `canUseTool` inspect `input` and return false.
 */
export class ToolDenyListPolicy implements PolicyEngine {
  private readonly denied: ReadonlySet<string>;

  constructor(deniedToolNames: Iterable<string>) {
    this.denied = new Set(deniedToolNames);
  }

  filterTools(_ctx: AgentRunContext, tools: AgentTool[]): AgentTool[] {
    return tools.filter((t) => !this.denied.has(t.name));
  }

  canUseTool(_ctx: AgentRunContext, tool: AgentTool, _input: unknown): boolean {
    return !this.denied.has(tool.name);
  }
}

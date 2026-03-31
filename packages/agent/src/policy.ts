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

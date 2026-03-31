import type { ToolCall } from "@renx/model";

import type { AgentRunContext } from "../types";
import type { AgentTool, BackendResolver, ExecutionBackend } from "./types";

/**
 * Default backend resolver that selects an execution backend based on
 * tool capabilities.
 *
 * - Tools requiring exec/filesystem capabilities are routed to the sandbox backend.
 * - All other tools use the local backend.
 */
export class DefaultBackendResolver implements BackendResolver {
  constructor(
    private readonly localBackend: ExecutionBackend,
    private readonly sandboxBackend: ExecutionBackend,
  ) {}

  async resolve(
    _ctx: AgentRunContext,
    tool: AgentTool,
    _call: ToolCall,
  ): Promise<ExecutionBackend | undefined> {
    if (tool.capabilities?.includes("requires-exec")) {
      return this.sandboxBackend;
    }
    if (
      tool.capabilities?.includes("requires-filesystem-read") ||
      tool.capabilities?.includes("requires-filesystem-write")
    ) {
      return this.sandboxBackend;
    }
    return this.localBackend;
  }
}

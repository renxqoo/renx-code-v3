import type { ToolCall } from "@renx/model";

import type { AgentRunContext } from "../types";
import type { AgentTool, BackendResolver, ExecutionBackend } from "./types";

const requiresSandboxBackend = (tool: AgentTool): boolean => {
  const capabilitySet = new Set(tool.capabilities ?? []);
  if (capabilitySet.has("requires-exec") || capabilitySet.has("exec")) {
    return true;
  }
  if (
    capabilitySet.has("requires-filesystem-read") ||
    capabilitySet.has("requires-filesystem-write")
  ) {
    return true;
  }

  const capabilityTags = new Set(tool.profile?.capabilityTags ?? []);
  return (
    capabilityTags.has("process_exec") ||
    capabilityTags.has("filesystem_read") ||
    capabilityTags.has("filesystem_write")
  );
};

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
    if (requiresSandboxBackend(tool)) {
      return this.sandboxBackend;
    }
    return this.localBackend;
  }
}

import { LocalBackend } from "@renx/agent";
import type { AgentRunContext, AgentTool, ExecutionBackend } from "@renx/agent";
import type { ToolCall } from "@renx/model";

import { SandboxBackend } from "./backend";
import type { SandboxBackendResolverOptions, SandboxResolver } from "./types";

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

export class SandboxBackendResolver implements SandboxResolver {
  private readonly localBackend: ExecutionBackend;

  constructor(private readonly options: SandboxBackendResolverOptions) {
    this.localBackend = options.localBackend ?? new LocalBackend();
  }

  async resolve(
    ctx: AgentRunContext,
    tool: AgentTool,
    call: ToolCall,
  ): Promise<ExecutionBackend | undefined> {
    const shouldUseSandbox = this.options.shouldUseSandbox
      ? this.options.shouldUseSandbox(ctx, tool, call)
      : requiresSandboxBackend(tool);
    if (!shouldUseSandbox) {
      return this.localBackend;
    }

    const lease = this.options.buildLease(ctx, tool, call);
    const negotiatedLease = lease.capabilities
      ? lease
      : {
          ...lease,
          capabilities: await this.options.manager.capabilitiesFor(lease),
        };
    return new SandboxBackend({
      manager: this.options.manager,
      lease: negotiatedLease,
    });
  }
}

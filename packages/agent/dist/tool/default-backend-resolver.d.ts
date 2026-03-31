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
export declare class DefaultBackendResolver implements BackendResolver {
    private readonly localBackend;
    private readonly sandboxBackend;
    constructor(localBackend: ExecutionBackend, sandboxBackend: ExecutionBackend);
    resolve(_ctx: AgentRunContext, tool: AgentTool, _call: ToolCall): Promise<ExecutionBackend | undefined>;
}
//# sourceMappingURL=default-backend-resolver.d.ts.map
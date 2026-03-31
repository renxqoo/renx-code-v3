import type { ToolCall } from "@renx/model";
import type { AgentStatePatch } from "../types";
import type { BackendResolver, ToolExecutionResult, ToolRegistry } from "./types";
import type { AggregatedDecision, MiddlewarePipeline } from "../middleware/pipeline";
/**
 * Executes tool calls through the middleware pipeline.
 *
 * Flow: lookup → beforeTool middleware → resolve backend → invoke → afterTool middleware
 *
 * Does NOT mutate ctx — all state patches are returned for the caller to apply.
 */
export declare class ToolExecutor {
    private readonly registry;
    private readonly middleware;
    private readonly backendResolver?;
    constructor(registry: ToolRegistry, middleware: MiddlewarePipeline, backendResolver?: BackendResolver | undefined);
    run(call: ToolCall, ctx: Parameters<MiddlewarePipeline["runBeforeTool"]>[0]): Promise<ToolExecutorRunResult>;
}
export type ToolExecutorRunResult = {
    type: "completed";
    result: ToolExecutionResult;
    shouldStop: boolean;
    statePatches: AgentStatePatch[];
} | {
    type: "stopped";
    reason: string;
    tool: import("./types").AgentTool;
    call: ToolCall;
    statePatches: AggregatedDecision["statePatch"];
};
//# sourceMappingURL=executor.d.ts.map
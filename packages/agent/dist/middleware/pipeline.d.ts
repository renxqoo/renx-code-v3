import type { ModelRequest, ModelResponse, ToolCall } from "@renx/model";
import type { AgentError } from "../errors";
import type { AgentResult, AgentRunContext, AgentStatePatch } from "../types";
import type { ToolExecutionResult } from "../tool/types";
import type { AgentMiddleware } from "./types";
/**
 * Aggregated decisions from all middleware.
 */
export interface AggregatedDecision {
    statePatch: AgentStatePatch[];
    shouldStop: boolean;
}
/**
 * Ordered middleware pipeline.
 */
export declare class MiddlewarePipeline {
    private readonly middlewares;
    constructor(middlewares?: AgentMiddleware[]);
    runBeforeRun(ctx: AgentRunContext): Promise<void>;
    runBeforeModel(ctx: AgentRunContext, req: ModelRequest): Promise<ModelRequest>;
    runAfterModel(ctx: AgentRunContext, resp: ModelResponse): Promise<ModelResponse>;
    runBeforeTool(ctx: AgentRunContext, call: ToolCall): Promise<AggregatedDecision>;
    runAfterTool(ctx: AgentRunContext, result: ToolExecutionResult): Promise<AggregatedDecision>;
    runOnError(ctx: AgentRunContext, error: AgentError): Promise<void>;
    runAfterRun(ctx: AgentRunContext, result: AgentResult): Promise<void>;
}
//# sourceMappingURL=pipeline.d.ts.map
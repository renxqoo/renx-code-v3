import type { ModelRequest, ModelResponse, ToolCall } from "@renx/model";
import type { AgentError } from "../errors";
import type { AgentResult, AgentRunContext, AgentStatePatch } from "../types";
import type { ToolExecutionResult } from "../tool/types";
/**
 * A decision returned by middleware to influence runtime behavior.
 */
export interface MiddlewareDecision {
    statePatch?: AgentStatePatch;
    stopCurrentStep?: boolean;
}
/**
 * Agent middleware hooks.
 *
 * Middleware provides cross-cutting capabilities at defined lifecycle points.
 * Each hook is optional — implement only what you need.
 */
export interface AgentMiddleware {
    name: string;
    /** Called once at the start of a run, before the main loop. */
    beforeRun?(ctx: AgentRunContext): Promise<void> | void;
    /** Called before each model call. May modify the request. */
    beforeModel?(ctx: AgentRunContext, req: ModelRequest): Promise<ModelRequest> | ModelRequest;
    /** Called after each model call. May modify the response. */
    afterModel?(ctx: AgentRunContext, resp: ModelResponse): Promise<ModelResponse> | ModelResponse;
    /** Called before each tool invocation. May return a decision to stop or patch state. */
    beforeTool?(ctx: AgentRunContext, call: ToolCall): Promise<MiddlewareDecision | void> | MiddlewareDecision | void;
    /** Called after each tool invocation. May return a decision to patch state. */
    afterTool?(ctx: AgentRunContext, result: ToolExecutionResult): Promise<MiddlewareDecision | void> | MiddlewareDecision | void;
    /** Called when an error occurs. Cannot suppress the error. */
    onError?(ctx: AgentRunContext, error: AgentError): Promise<void> | void;
    /** Called once at the end of a run, regardless of outcome. */
    afterRun?(ctx: AgentRunContext, result: AgentResult): Promise<void> | void;
}
//# sourceMappingURL=types.d.ts.map
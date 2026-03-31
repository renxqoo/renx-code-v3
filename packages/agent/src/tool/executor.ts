import type { ToolCall } from "@renx/model";

import { AgentError } from "../errors";
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
export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly middleware: MiddlewarePipeline,
    private readonly backendResolver?: BackendResolver,
  ) {}

  async run(
    call: ToolCall,
    ctx: Parameters<MiddlewarePipeline["runBeforeTool"]>[0],
  ): Promise<ToolExecutorRunResult> {
    const tool = this.registry.get(call.name);

    if (!tool) {
      throw new AgentError({
        code: "TOOL_NOT_FOUND",
        message: `Tool not found: ${call.name}`,
        metadata: { toolName: call.name, toolCallId: call.id },
      });
    }

    // Run beforeTool middleware — may signal stop
    const beforeDecision = await this.middleware.runBeforeTool(ctx, call);

    if (beforeDecision.shouldStop) {
      return {
        type: "stopped",
        reason: "middleware_stop",
        tool,
        call,
        statePatches: beforeDecision.statePatch,
      };
    }

    // Resolve execution backend
    const backend = this.backendResolver
      ? await this.backendResolver.resolve(ctx, tool, call)
      : undefined;

    // Invoke the tool
    const toolResult = await tool.invoke(call.input, {
      runContext: ctx,
      toolCall: call,
      backend,
    });

    const executionResult: ToolExecutionResult = {
      tool,
      call,
      output: toolResult,
    };

    // Run afterTool middleware
    const afterDecision = await this.middleware.runAfterTool(ctx, executionResult);

    // Collect all state patches (before + after middleware)
    const statePatches = [...beforeDecision.statePatch, ...afterDecision.statePatch];

    return {
      type: "completed",
      result: executionResult,
      shouldStop: afterDecision.shouldStop,
      statePatches,
    };
  }
}

export type ToolExecutorRunResult =
  | {
      type: "completed";
      result: ToolExecutionResult;
      shouldStop: boolean;
      statePatches: AgentStatePatch[];
    }
  | {
      type: "stopped";
      reason: string;
      tool: import("./types").AgentTool;
      call: ToolCall;
      statePatches: AggregatedDecision["statePatch"];
    };

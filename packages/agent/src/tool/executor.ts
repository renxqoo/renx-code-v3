import type { ToolCall } from "@renx/model";

import { AgentError } from "../errors";
import type { AgentRunContext, AgentStatePatch } from "../types";

import type { AgentTool, BackendResolver, ToolExecutionResult, ToolRegistry } from "./types";

import type { AggregatedDecision, MiddlewarePipeline } from "../middleware/pipeline";

/**
 * Result of a single tool execution within a batch.
 */
export interface BatchToolResult {
  call: ToolCall;
  result: ToolExecutionResult;
  statePatches: AgentStatePatch[];
}

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

  async run(call: ToolCall, ctx: AgentRunContext): Promise<ToolExecutorRunResult> {
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

  /**
   * Execute multiple tool calls, running concurrency-safe tools in parallel.
   *
   * Partitions calls into groups of adjacent concurrency-safe tools (which run
   * concurrently) and serial-only tools (which run one at a time). Returns
   * results in the same order as the input calls.
   */
  async runBatch(calls: ToolCall[], ctx: AgentRunContext): Promise<BatchToolResult[]> {
    const groups = this.partitionCalls(calls);
    const results: BatchToolResult[] = [];

    for (const group of groups) {
      if (group.concurrent) {
        const batchResults = await Promise.all(
          group.calls.map((call) => this.runSingle(call, ctx)),
        );
        results.push(...batchResults);
      } else {
        for (const call of group.calls) {
          results.push(await this.runSingle(call, ctx));
        }
      }
    }

    return results;
  }

  /**
   * Execute a single tool call without batch logic. Used by runBatch internally.
   */
  private async runSingle(call: ToolCall, ctx: AgentRunContext): Promise<BatchToolResult> {
    const tool = this.registry.get(call.name);
    if (!tool) {
      throw new AgentError({
        code: "TOOL_NOT_FOUND",
        message: `Tool not found: ${call.name}`,
        metadata: { toolName: call.name, toolCallId: call.id },
      });
    }

    const beforeDecision = await this.middleware.runBeforeTool(ctx, call);
    const backend = this.backendResolver
      ? await this.backendResolver.resolve(ctx, tool, call)
      : undefined;

    const toolResult = await tool.invoke(call.input, {
      runContext: ctx,
      toolCall: call,
      backend,
    });

    const executionResult: ToolExecutionResult = { tool, call, output: toolResult };
    const afterDecision = await this.middleware.runAfterTool(ctx, executionResult);

    return {
      call,
      result: executionResult,
      statePatches: [...beforeDecision.statePatch, ...afterDecision.statePatch],
    };
  }

  /**
   * Partition tool calls into groups of concurrent-safe and serial-only calls.
   * Adjacent concurrency-safe calls are grouped together for parallel execution.
   */
  private partitionCalls(calls: ToolCall[]): Array<{ calls: ToolCall[]; concurrent: boolean }> {
    if (calls.length === 0) return [];

    const groups: Array<{ calls: ToolCall[]; concurrent: boolean }> = [];
    let currentCalls: ToolCall[] = [calls[0]!];
    let currentSafe = this.isConcurrencySafe(calls[0]!);

    for (let i = 1; i < calls.length; i++) {
      const call = calls[i]!;
      const safe = this.isConcurrencySafe(call);

      if (safe === currentSafe) {
        currentCalls.push(call);
      } else {
        groups.push({ calls: currentCalls, concurrent: currentSafe });
        currentCalls = [call];
        currentSafe = safe;
      }
    }
    groups.push({ calls: currentCalls, concurrent: currentSafe });

    return groups;
  }

  private isConcurrencySafe(call: ToolCall): boolean {
    const tool = this.registry.get(call.name);
    return tool?.isConcurrencySafe?.(call.input) ?? false;
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
      tool: AgentTool;
      call: ToolCall;
      statePatches: AggregatedDecision["statePatch"];
    };

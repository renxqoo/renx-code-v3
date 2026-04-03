import type { ToolCall } from "@renx/model";

import { AgentError } from "../errors";
import { generateId } from "../helpers";
import type { AgentRunContext, AgentStatePatch } from "../types";
import type { AuditLogger, AuditEventType } from "../types";

import type {
  AgentTool,
  BackendResolver,
  ToolExecutionResult,
  ToolRegistry,
  ToolResult,
} from "./types";
import { validateToolInput } from "./input-validation";

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
  private readonly toolMaxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly middleware: MiddlewarePipeline,
    private readonly backendResolver?: BackendResolver,
    private readonly audit?: AuditLogger,
    retryConfig?: {
      toolMaxRetries?: number;
      retryBaseDelayMs?: number;
      retryMaxDelayMs?: number;
    },
  ) {
    this.toolMaxRetries = Math.max(0, retryConfig?.toolMaxRetries ?? 1);
    this.retryBaseDelayMs = Math.max(0, retryConfig?.retryBaseDelayMs ?? 50);
    this.retryMaxDelayMs = Math.max(0, retryConfig?.retryMaxDelayMs ?? 500);
  }

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

    let attempts = 0;
    while (true) {
      try {
        // Invoke the tool
        const toolCtx = {
          runContext: ctx,
          toolCall: call,
          backend,
        };
        const validatedInput = validateToolInput(tool, call.input, toolCtx);
        const toolResult = await tool.invoke(validatedInput, toolCtx);

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
      } catch (error) {
        const toolError =
          error instanceof AgentError
            ? error
            : new AgentError({
                code: "TOOL_ERROR",
                message: error instanceof Error ? error.message : "Tool execution failed",
                cause: error,
                metadata: { toolName: call.name, toolCallId: call.id },
              });

        await this.middleware.runOnError(ctx, toolError);
        const shouldRetry = this.shouldRetryError(toolError) && attempts < this.toolMaxRetries;
        if (shouldRetry) {
          attempts += 1;
          await sleep(computeBackoffMs(attempts, this.retryBaseDelayMs, this.retryMaxDelayMs));
          continue;
        }
        const errorOutput = this.buildErrorToolResult(tool, call, toolError);
        const executionResult: ToolExecutionResult = {
          tool,
          call,
          output: errorOutput,
        };
        const afterDecision = await this.middleware.runAfterTool(ctx, executionResult);
        const statePatches = [...beforeDecision.statePatch, ...afterDecision.statePatch];
        this.emitAudit(ctx, "tool_failed", {
          toolName: call.name,
          toolCallId: call.id,
          code: toolError.code,
          message: toolError.message,
        });
        return {
          type: "completed",
          result: executionResult,
          shouldStop: afterDecision.shouldStop,
          statePatches,
        };
      }
    }
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

    let attempts = 0;
    while (true) {
      try {
        const toolCtx = {
          runContext: ctx,
          toolCall: call,
          backend,
        };
        const validatedInput = validateToolInput(tool, call.input, toolCtx);
        const toolResult = await tool.invoke(validatedInput, toolCtx);

        const executionResult: ToolExecutionResult = { tool, call, output: toolResult };
        const afterDecision = await this.middleware.runAfterTool(ctx, executionResult);

        return {
          call,
          result: executionResult,
          statePatches: [...beforeDecision.statePatch, ...afterDecision.statePatch],
        };
      } catch (error) {
        const toolError =
          error instanceof AgentError
            ? error
            : new AgentError({
                code: "TOOL_ERROR",
                message: error instanceof Error ? error.message : "Tool execution failed",
                cause: error,
                metadata: { toolName: call.name, toolCallId: call.id },
              });

        await this.middleware.runOnError(ctx, toolError);
        const shouldRetry = this.shouldRetryError(toolError) && attempts < this.toolMaxRetries;
        if (shouldRetry) {
          attempts += 1;
          await sleep(computeBackoffMs(attempts, this.retryBaseDelayMs, this.retryMaxDelayMs));
          continue;
        }
        const errorOutput = this.buildErrorToolResult(tool, call, toolError);
        const executionResult: ToolExecutionResult = { tool, call, output: errorOutput };
        const afterDecision = await this.middleware.runAfterTool(ctx, executionResult);
        this.emitAudit(ctx, "tool_failed", {
          toolName: call.name,
          toolCallId: call.id,
          code: toolError.code,
          message: toolError.message,
        });
        return {
          call,
          result: executionResult,
          statePatches: [...beforeDecision.statePatch, ...afterDecision.statePatch],
        };
      }
    }
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

  private emitAudit(
    ctx: AgentRunContext,
    type: AuditEventType,
    payload: Record<string, unknown>,
  ): void {
    const logger = this.audit ?? ctx.services.audit;
    if (!logger) return;
    logger.log({
      id: generateId(),
      runId: ctx.state.runId,
      type,
      timestamp: new Date().toISOString(),
      payload,
    });
  }

  private shouldRetryError(error: unknown): boolean {
    if (error instanceof AgentError) return error.retryable;
    if (!error || typeof error !== "object") return false;
    const retryable = (error as { retryable?: unknown }).retryable;
    return retryable === true;
  }

  private buildErrorToolResult(tool: AgentTool, call: ToolCall, error: AgentError): ToolResult {
    const structured = {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.metadata,
      },
    };
    return {
      content: JSON.stringify(structured),
      structured,
      metadata: {
        ok: false,
        toolName: tool.name,
        toolCallId: call.id,
        errorCode: error.code,
      },
    };
  }
}

const computeBackoffMs = (attempt: number, baseDelayMs: number, maxDelayMs: number): number =>
  Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));

const sleep = async (ms: number): Promise<void> => {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

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

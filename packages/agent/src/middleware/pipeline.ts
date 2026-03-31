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
export class MiddlewarePipeline {
  private readonly middlewares: readonly AgentMiddleware[];

  constructor(middlewares: AgentMiddleware[] = []) {
    this.middlewares = [...middlewares];
  }

  async runBeforeRun(ctx: AgentRunContext): Promise<void> {
    for (const mw of this.middlewares) {
      if (mw.beforeRun) {
        await mw.beforeRun(ctx);
      }
    }
  }

  async runBeforeModel(ctx: AgentRunContext, req: ModelRequest): Promise<ModelRequest> {
    let current = req;
    for (const mw of this.middlewares) {
      if (mw.beforeModel) {
        current = await mw.beforeModel(ctx, current);
      }
    }
    return current;
  }

  async runAfterModel(ctx: AgentRunContext, resp: ModelResponse): Promise<ModelResponse> {
    let current = resp;
    for (const mw of this.middlewares) {
      if (mw.afterModel) {
        current = await mw.afterModel(ctx, current);
      }
    }
    return current;
  }

  async runBeforeTool(ctx: AgentRunContext, call: ToolCall): Promise<AggregatedDecision> {
    const patches: AgentStatePatch[] = [];
    let shouldStop = false;

    for (const mw of this.middlewares) {
      if (mw.beforeTool) {
        const decision = await mw.beforeTool(ctx, call);
        if (decision) {
          if (decision.statePatch) {
            patches.push(decision.statePatch);
          }
          if (decision.stopCurrentStep) {
            shouldStop = true;
          }
        }
      }
    }

    return { statePatch: patches, shouldStop };
  }

  async runAfterTool(
    ctx: AgentRunContext,
    result: ToolExecutionResult,
  ): Promise<AggregatedDecision> {
    const patches: AgentStatePatch[] = [];
    let shouldStop = false;

    for (const mw of this.middlewares) {
      if (mw.afterTool) {
        const decision = await mw.afterTool(ctx, result);
        if (decision) {
          if (decision.statePatch) {
            patches.push(decision.statePatch);
          }
          if (decision.stopCurrentStep) {
            shouldStop = true;
          }
        }
      }
    }

    return { statePatch: patches, shouldStop };
  }

  async runOnError(ctx: AgentRunContext, error: AgentError): Promise<void> {
    for (const mw of this.middlewares) {
      if (mw.onError) {
        try {
          await mw.onError(ctx, error);
        } catch {
          // Middleware error handlers must not throw — swallow silently
        }
      }
    }
  }

  async runAfterRun(ctx: AgentRunContext, result: AgentResult): Promise<void> {
    for (const mw of this.middlewares) {
      if (mw.afterRun) {
        await mw.afterRun(ctx, result);
      }
    }
  }
}

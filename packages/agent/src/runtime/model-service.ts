import type { ModelClient, ModelRequest, ModelResponse, ToolCall } from "@renx/model";

import { AgentError } from "../errors";
import type { AgentRunContext, AgentStreamEvent } from "../types";

import {
  computeBackoffMs,
  getDoneEventIteration,
  getDoneEventResponseId,
  getDoneEventUsage,
  sleep,
} from "./utils";

export class RuntimeModelService {
  constructor(
    private readonly modelClient: ModelClient,
    private readonly modelMaxRetries: number,
    private readonly retryBaseDelayMs: number,
    private readonly retryMaxDelayMs: number,
  ) {}

  async generateWithRetry(modelRequest: ModelRequest): Promise<ModelResponse> {
    let attempts = 0;
    while (true) {
      try {
        return await this.modelClient.generate(modelRequest);
      } catch (error) {
        const shouldRetry = this.shouldRetryModelError(error) && attempts < this.modelMaxRetries;
        if (!shouldRetry) throw error;
        attempts += 1;
        await sleep(computeBackoffMs(attempts, this.retryBaseDelayMs, this.retryMaxDelayMs));
      }
    }
  }

  async *consumeModelStreamWithRetry(
    modelRequest: ModelRequest,
    ctx: AgentRunContext,
  ): AsyncGenerator<AgentStreamEvent, { response: ModelResponse }> {
    let attempts = 0;
    while (true) {
      try {
        return yield* this.consumeModelStream(modelRequest, ctx);
      } catch (error) {
        const shouldRetry = this.shouldRetryModelError(error) && attempts < this.modelMaxRetries;
        if (!shouldRetry) throw error;
        attempts += 1;
        await sleep(computeBackoffMs(attempts, this.retryBaseDelayMs, this.retryMaxDelayMs));
      }
    }
  }

  private async *consumeModelStream(
    modelRequest: ModelRequest,
    _ctx: AgentRunContext,
  ): AsyncGenerator<AgentStreamEvent, { response: ModelResponse }> {
    let textBuffer = "";
    const toolCalls: ToolCall[] = [];
    let responseId: string | undefined;
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    let iteration: Record<string, unknown> | undefined;

    for await (const event of this.modelClient.stream(modelRequest)) {
      switch (event.type) {
        case "text_delta":
          textBuffer += event.text;
          yield { type: "assistant_delta", text: event.text };
          break;
        case "tool_call_delta":
          yield { type: "tool_call_delta", partial: event.partial };
          break;
        case "tool_call":
          toolCalls.push(event.call);
          break;
        case "done":
          responseId = getDoneEventResponseId(event);
          usage = getDoneEventUsage(event);
          iteration = getDoneEventIteration(event);
          break;
      }
    }

    const response: ModelResponse =
      toolCalls.length > 0
        ? {
            type: "tool_calls",
            toolCalls,
            ...(responseId ? { responseId } : {}),
            ...(usage ? { usage } : {}),
            ...(iteration ? { iteration } : {}),
          }
        : {
            type: "final",
            output: textBuffer,
            ...(responseId ? { responseId } : {}),
            ...(usage ? { usage } : {}),
            ...(iteration ? { iteration } : {}),
          };
    return { response };
  }

  private shouldRetryModelError(error: unknown): boolean {
    if (error instanceof AgentError) return error.retryable;
    if (!error || typeof error !== "object") return false;
    const maybe = error as { retryable?: unknown; status?: unknown; code?: unknown };
    if (maybe.retryable === true) return true;
    if (typeof maybe.status === "number" && (maybe.status === 429 || maybe.status >= 500))
      return true;
    return maybe.code === "MODEL_ERROR";
  }
}

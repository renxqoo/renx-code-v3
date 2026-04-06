import {
  BaseModelAdapter,
  type ContextualErrorNormalizer,
  type MessageRenderer,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
  type ResponseNormalizer,
  type TokenUsage,
  type ToolRenderer,
} from "@renx/model";

import { createErrorNormalizer } from "./error-normalizer";
import { OpenAIChatMessageRenderer, OpenAIToolRenderer } from "./renderers";
import { OpenAIResponseNormalizer } from "./response-normalizer";
import { parseSSEResponse } from "./sse-parser";
import type { OpenAIStreamDelta } from "./sse-parser";
import type { OpenAIChatMessage, OpenAIToolDefinition } from "./types";

export interface OpenAICompatAdapterOptions {
  name: string;
  endpoint: string;
  stripPrefix?: string;
  errorNormalizer?: ContextualErrorNormalizer;
  responseNormalizer?: ResponseNormalizer;
  messageRenderer?: MessageRenderer<OpenAIChatMessage>;
  toolRenderer?: ToolRenderer<OpenAIToolDefinition>;
}

/**
 * Shared adapter for all OpenAI-compatible chat completion APIs.
 * Used by OpenAI, GLM, DeepSeek, Moonshot, and any provider that follows the
 * OpenAI chat completion protocol.
 */
export class OpenAICompatAdapter extends BaseModelAdapter {
  override readonly name: string;

  private readonly endpoint: string;
  private readonly prefix: string;
  private readonly errorNormalizer: ContextualErrorNormalizer;
  private readonly responseNormalizer: ResponseNormalizer;
  private readonly messageRenderer: MessageRenderer<OpenAIChatMessage>;
  private readonly toolRenderer: ToolRenderer<OpenAIToolDefinition>;

  constructor(provider: Provider, options: OpenAICompatAdapterOptions) {
    super(provider);
    this.name = options.name;
    this.endpoint = options.endpoint;
    this.prefix = options.stripPrefix ?? `${options.name}:`;
    this.errorNormalizer = options.errorNormalizer ?? createErrorNormalizer(options.name);
    this.responseNormalizer = options.responseNormalizer ?? new OpenAIResponseNormalizer();
    this.messageRenderer = options.messageRenderer ?? new OpenAIChatMessageRenderer();
    this.toolRenderer = options.toolRenderer ?? new OpenAIToolRenderer();
  }

  protected override toProviderRequest(request: ModelRequest): ProviderRequest {
    const systemPrompt = this.messageRenderer.renderSystemPrompt(request.systemPrompt);
    const renderedMessages = this.messageRenderer.renderMessages(request.messages);
    const renderedTools = this.toolRenderer.renderTools(request.tools);

    const model = request.model.startsWith(this.prefix)
      ? request.model.slice(this.prefix.length)
      : request.model;

    const body: Record<string, unknown> = {
      model,
      messages: systemPrompt === null ? renderedMessages : [systemPrompt, ...renderedMessages],
    };

    if (renderedTools.length > 0) body.tools = renderedTools;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.contextMetadata?.contextManagement) {
      body.context_management = request.contextMetadata.contextManagement;
    }

    return {
      url: this.endpoint,
      headers: { "Content-Type": "application/json" },
      body,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.metadata === undefined && request.contextMetadata === undefined
        ? {}
        : {
            metadata: {
              ...request.metadata,
              ...(request.contextMetadata?.apiViewId
                ? { contextApiViewId: request.contextMetadata.apiViewId }
                : {}),
              ...(request.contextMetadata?.compactBoundaryId
                ? { contextCompactBoundaryId: request.contextMetadata.compactBoundaryId }
                : {}),
              ...(request.contextMetadata?.thresholdLevel
                ? { contextThresholdLevel: request.contextMetadata.thresholdLevel }
                : {}),
              ...(request.contextMetadata?.querySource
                ? { contextQuerySource: request.contextMetadata.querySource }
                : {}),
            },
          }),
    };
  }

  protected override fromProviderResponse(
    response: ProviderResponse,
    request: ModelRequest,
  ): ModelResponse {
    if (response.status >= 400) throw response;

    const modelResponse = this.responseNormalizer.normalize(response);

    if (modelResponse.type === "final" && modelResponse.output.length === 0) {
      return {
        type: "final",
        output: "",
        metadata: { provider: this.name, model: request.model },
      };
    }

    return modelResponse;
  }

  protected override normalizeError(error: unknown, request: ModelRequest) {
    return this.errorNormalizer.normalize(error, request.model);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const streamProvider = this.streamingProvider;

    if (streamProvider === undefined) {
      throw new Error(`Provider "${this.name}" does not support streaming`);
    }

    yield* this.withErrorNormalization(request, this.doStream(request, streamProvider));
  }

  private async *doStream(
    request: ModelRequest,
    streamProvider: NonNullable<typeof this.streamingProvider>,
  ): AsyncIterable<ModelStreamEvent> {
    const providerRequest = this.toProviderRequest(request);
    const body = providerRequest.body as Record<string, unknown>;
    body.stream = true;

    const toolCallAccumulators = new Map<number, { id: string; name: string; arguments: string }>();
    let responseId: string | undefined;
    let usage: TokenUsage | undefined;

    for await (const delta of parseSSEResponse(streamProvider.executeStream!(providerRequest))) {
      if (responseId === undefined && typeof delta.id === "string") {
        responseId = delta.id;
      }
      if (usage === undefined) {
        usage = readStreamUsage(delta);
      }
      const choice = delta.choices[0];

      if (!choice) continue;

      if (choice.delta.content != null && choice.delta.content.length > 0) {
        yield { type: "text_delta", text: choice.delta.content };
      }

      if (choice.delta.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const idx = tc.index;

          if (!toolCallAccumulators.has(idx)) {
            toolCallAccumulators.set(idx, {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              arguments: "",
            });
          }

          const acc = toolCallAccumulators.get(idx)!;

          if (tc.id != null) acc.id = tc.id;
          if (tc.function?.name != null) acc.name = tc.function.name;
          if (tc.function?.arguments != null) acc.arguments += tc.function.arguments;

          yield { type: "tool_call_delta", partial: tc };
        }
      }

      if (choice.finish_reason === "tool_calls" && toolCallAccumulators.size > 0) {
        for (const [, acc] of toolCallAccumulators) {
          yield {
            type: "tool_call",
            call: {
              id: acc.id,
              name: acc.name,
              input: parseStreamToolArguments(acc.arguments),
            },
          };
        }

        toolCallAccumulators.clear();
      }
    }

    yield {
      type: "done",
      ...(responseId ? { responseId } : {}),
      ...(usage ? { usage } : {}),
    };
  }
}

const parseStreamToolArguments = (argumentsText: string): unknown => {
  if (argumentsText.length === 0) {
    return {};
  }

  try {
    return JSON.parse(argumentsText) as unknown;
  } catch {
    return { raw: argumentsText };
  }
};

const readStreamUsage = (delta: OpenAIStreamDelta): TokenUsage | undefined => {
  const usageRecord = delta.usage;
  if (!usageRecord) return undefined;
  const numberOrUndefined = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const inputTokens = numberOrUndefined(usageRecord.prompt_tokens);
  const outputTokens = numberOrUndefined(usageRecord.completion_tokens);
  const totalTokens = numberOrUndefined(usageRecord.total_tokens);
  const mapped = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
  return Object.keys(mapped).length > 0 ? mapped : undefined;
};

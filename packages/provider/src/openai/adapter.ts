import {
  BaseModelAdapter,
  type ContextualErrorNormalizer,
  type ModelRequest,
  type ModelResponse,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
  type ResponseNormalizer,
} from "@renx/model";

import { OpenAIErrorNormalizer } from "./error-normalizer";
import { OpenAIMessageRenderer, OpenAIToolRenderer } from "./renderers";
import { OpenAIResponseNormalizer } from "./response-normalizer";

export interface OpenAIModelAdapterOptions {
  endpoint?: string;
  errorNormalizer?: ContextualErrorNormalizer;
  responseNormalizer?: ResponseNormalizer;
  messageRenderer?: OpenAIMessageRenderer;
  toolRenderer?: OpenAIToolRenderer;
}

export class OpenAIModelAdapter extends BaseModelAdapter {
  name = "openai";

  private readonly endpoint: string;
  private readonly errorNormalizer: ContextualErrorNormalizer;
  private readonly responseNormalizer: ResponseNormalizer;
  private readonly messageRenderer: OpenAIMessageRenderer;
  private readonly toolRenderer: OpenAIToolRenderer;

  constructor(provider: Provider, options: OpenAIModelAdapterOptions = {}) {
    super(provider);
    this.endpoint = options.endpoint ?? "https://api.openai.com/v1/chat/completions";
    this.errorNormalizer = options.errorNormalizer ?? new OpenAIErrorNormalizer();
    this.responseNormalizer = options.responseNormalizer ?? new OpenAIResponseNormalizer();
    this.messageRenderer = options.messageRenderer ?? new OpenAIMessageRenderer();
    this.toolRenderer = options.toolRenderer ?? new OpenAIToolRenderer();
  }

  protected toProviderRequest(request: ModelRequest): ProviderRequest {
    const systemPrompt = this.messageRenderer.renderSystemPrompt(request.systemPrompt);
    const renderedMessages = this.messageRenderer.renderMessages(request.messages);
    const renderedTools = this.toolRenderer.renderTools(request.tools);

    const body: Record<string, unknown> = {
      model: stripOpenAIPrefix(request.model),
      messages: systemPrompt === null ? renderedMessages : [systemPrompt, ...renderedMessages],
    };

    if (renderedTools.length > 0) {
      body.tools = renderedTools;
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.maxTokens !== undefined) {
      body.max_tokens = request.maxTokens;
    }

    return {
      url: this.endpoint,
      headers: {
        "Content-Type": "application/json",
      },
      body,
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    };
  }

  protected fromProviderResponse(response: ProviderResponse, request: ModelRequest): ModelResponse {
    if (response.status >= 400) {
      throw response;
    }

    const modelResponse = this.responseNormalizer.normalize(response);

    if (modelResponse.type === "final" && modelResponse.output.length === 0) {
      return {
        type: "final",
        output: "",
        metadata: {
          provider: this.name,
          model: request.model,
        },
      };
    }

    return modelResponse;
  }

  protected normalizeError(error: unknown, request: ModelRequest) {
    return this.errorNormalizer.normalize(error, request.model);
  }
}

const stripOpenAIPrefix = (model: string): string => {
  return model.startsWith("openai:") ? model.slice("openai:".length) : model;
};

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

import { OpenAIMessageRenderer, OpenAIToolRenderer } from "../openai/renderers";
import { OpenAIResponseNormalizer } from "../openai/response-normalizer";
import { GlmErrorNormalizer } from "./error-normalizer";

export interface GlmModelAdapterOptions {
  endpoint?: string;
  errorNormalizer?: ContextualErrorNormalizer;
  responseNormalizer?: ResponseNormalizer;
  messageRenderer?: OpenAIMessageRenderer;
  toolRenderer?: OpenAIToolRenderer;
}

export class GlmModelAdapter extends BaseModelAdapter {
  name = "glm";

  private readonly endpoint: string;
  private readonly errorNormalizer: ContextualErrorNormalizer;
  private readonly responseNormalizer: ResponseNormalizer;
  private readonly messageRenderer: OpenAIMessageRenderer;
  private readonly toolRenderer: OpenAIToolRenderer;

  constructor(provider: Provider, options: GlmModelAdapterOptions = {}) {
    super(provider);
    this.endpoint =
      options.endpoint ?? "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions";
    this.errorNormalizer = options.errorNormalizer ?? new GlmErrorNormalizer();
    this.responseNormalizer = options.responseNormalizer ?? new OpenAIResponseNormalizer();
    this.messageRenderer = options.messageRenderer ?? new OpenAIMessageRenderer();
    this.toolRenderer = options.toolRenderer ?? new OpenAIToolRenderer();
  }

  protected toProviderRequest(request: ModelRequest): ProviderRequest {
    const systemPrompt = this.messageRenderer.renderSystemPrompt(request.systemPrompt);
    const renderedMessages = this.messageRenderer.renderMessages(request.messages);
    const renderedTools = this.toolRenderer.renderTools(request.tools);

    const body: Record<string, unknown> = {
      model: stripGlmPrefix(request.model),
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

const stripGlmPrefix = (model: string): string => {
  return model.startsWith("glm:") ? model.slice("glm:".length) : model;
};

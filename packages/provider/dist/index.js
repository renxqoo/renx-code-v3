// src/client.ts
import {
  createModelClient as createBaseModelClient
} from "@renx/model";
var createModelClient = (options) => {
  const providers = options.providers;
  if (providers.length === 0) {
    throw new Error("At least one provider must be configured.");
  }
  return createBaseModelClient({
    providers,
    resolveModel: options.resolveModel ?? createInferResolver(providers),
    ...options.retry === void 0 ? {} : { retry: options.retry }
  });
};
var createPrefixResolver = (validProviders) => {
  const valid = new Set(validProviders);
  return (model) => {
    const index = model.indexOf(":");
    if (index === -1) {
      throw new Error(`Model must use "provider:model" format, got: "${model}"`);
    }
    const provider = model.slice(0, index);
    const providerModel = model.slice(index + 1);
    if (!providerModel) {
      throw new Error(`Invalid model: "${model}"`);
    }
    if (!valid.has(provider)) {
      throw new Error(`Provider not configured: ${provider}`);
    }
    return { id: model, provider, providerModel };
  };
};
var createInferResolver = (providers) => {
  const validNames = new Set(providers.map((p) => p.name));
  return (model) => {
    const index = model.indexOf(":");
    if (index !== -1) {
      const provider = model.slice(0, index);
      const providerModel = model.slice(index + 1);
      if (!providerModel) {
        throw new Error(`Invalid model: "${model}"`);
      }
      if (!validNames.has(provider)) {
        throw new Error(`Provider not configured: ${provider}`);
      }
      return { id: model, provider, providerModel };
    }
    for (const p of providers) {
      if (!p.inferModel) continue;
      const providerModel = p.inferModel(model);
      if (providerModel !== null) {
        return { id: model, provider: p.name, providerModel };
      }
    }
    throw new Error(`Cannot infer provider from model: "${model}"`);
  };
};

// src/openai.ts
import { ApiKeyAuthProvider, HttpProvider } from "@renx/model";

// src/shared/adapter.ts
import {
  BaseModelAdapter
} from "@renx/model";

// src/shared/error-normalizer.ts
import {
  createNormalizedModelError,
  HttpProviderError
} from "@renx/model";
var createErrorNormalizer = (provider) => ({
  normalize: (error, model) => normalizeError(provider, error, model)
});
var normalizeError = (provider, error, model) => {
  const { error: resolved, model: resolvedModel } = unwrapEnvelope(error, model);
  if (resolved instanceof HttpProviderError) {
    return fromProviderResponse(provider, resolved.response, resolvedModel, resolved);
  }
  if (isProviderResponse(resolved)) {
    return fromProviderResponse(provider, resolved, resolvedModel);
  }
  if (resolved instanceof TypeError) {
    return createNormalizedModelError({
      message: resolved.message,
      provider,
      code: "NETWORK_ERROR",
      retryable: true,
      retryMode: "BACKOFF",
      raw: resolved,
      cause: resolved,
      ...resolvedModel === void 0 ? {} : { model: resolvedModel }
    });
  }
  if (resolved instanceof Error) {
    const isTimeout = resolved.name === "TimeoutError" || resolved.name === "AbortError";
    return createNormalizedModelError({
      message: resolved.message,
      provider,
      code: isTimeout ? "TIMEOUT" : "UNKNOWN",
      retryable: isTimeout,
      retryMode: isTimeout ? "BACKOFF" : "NONE",
      raw: resolved,
      cause: resolved,
      ...resolvedModel === void 0 ? {} : { model: resolvedModel }
    });
  }
  return createNormalizedModelError({
    message: `Unknown ${provider} provider error`,
    provider,
    code: "UNKNOWN",
    retryable: false,
    retryMode: "NONE",
    raw: resolved,
    ...resolvedModel === void 0 ? {} : { model: resolvedModel }
  });
};
var unwrapEnvelope = (input, model) => {
  if (!isRecord(input) || !("error" in input)) {
    return { error: input, ...model === void 0 ? {} : { model } };
  }
  const resolvedModel = typeof input.model === "string" ? input.model : model;
  return { error: input.error, ...resolvedModel === void 0 ? {} : { model: resolvedModel } };
};
var fromProviderResponse = (provider, response, model, cause) => {
  const payload = readErrorPayload(response.body);
  const message = payload.message ?? `${provider} request failed with status ${response.status}`;
  const retryAfterMs = parseRetryAfter(response.headers["retry-after"]);
  const classification = classifyHttpError(response.status, message, retryAfterMs);
  return createNormalizedModelError({
    message,
    provider,
    code: classification.code,
    retryable: classification.retryable,
    retryMode: classification.retryMode,
    raw: response,
    cause,
    httpStatus: response.status,
    ...model === void 0 ? {} : { model },
    ...retryAfterMs === void 0 ? {} : { retryAfterMs },
    ...payload.code === void 0 ? {} : { rawCode: payload.code },
    ...payload.type === void 0 ? {} : { rawType: payload.type }
  });
};
var classifyHttpError = (httpStatus, message, retryAfterMs) => {
  if (httpStatus === 401) return { code: "AUTH_ERROR", retryable: false, retryMode: "NONE" };
  if (httpStatus === 403) return { code: "PERMISSION_DENIED", retryable: false, retryMode: "NONE" };
  if (httpStatus === 408) return { code: "TIMEOUT", retryable: true, retryMode: "BACKOFF" };
  if (httpStatus === 429) {
    return {
      code: "RATE_LIMIT",
      retryable: true,
      retryMode: retryAfterMs === void 0 ? "BACKOFF" : "AFTER_DELAY"
    };
  }
  if (httpStatus >= 500) return { code: "SERVER_ERROR", retryable: true, retryMode: "BACKOFF" };
  if (httpStatus === 400 && isContextOverflow(message)) {
    return { code: "CONTEXT_OVERFLOW", retryable: true, retryMode: "TRANSFORM_AND_RETRY" };
  }
  return { code: "UNKNOWN", retryable: false, retryMode: "NONE" };
};
var isContextOverflow = (message) => {
  const lower = message.toLowerCase();
  return lower.includes("context length") || lower.includes("maximum context length");
};
var parseRetryAfter = (value) => {
  if (value === void 0) return void 0;
  const seconds = Number(value);
  return Number.isNaN(seconds) ? void 0 : seconds * 1e3;
};
var readErrorPayload = (body) => {
  if (!isRecord(body) || !isRecord(body.error)) return {};
  return {
    ...typeof body.error.message === "string" ? { message: body.error.message } : {},
    ...typeof body.error.code === "string" || typeof body.error.code === "number" ? { code: body.error.code } : {},
    ...typeof body.error.type === "string" ? { type: body.error.type } : {}
  };
};
var isProviderResponse = (value) => isRecord(value) && typeof value.status === "number" && isRecord(value.headers) && "body" in value;
var isRecord = (value) => typeof value === "object" && value !== null;

// src/shared/renderers.ts
var OpenAIChatMessageRenderer = class {
  renderSystemPrompt(systemPrompt) {
    if (systemPrompt.trim().length === 0) {
      return null;
    }
    return { role: "system", content: systemPrompt };
  }
  renderMessages(messages) {
    return messages.map((message) => {
      if (message.role === "tool") {
        const toolMessage = {
          role: "tool",
          content: message.content
        };
        if (message.name !== void 0) {
          toolMessage.name = message.name;
        }
        if (message.toolCallId !== void 0) {
          toolMessage.tool_call_id = message.toolCallId;
        }
        return toolMessage;
      }
      const renderedMessage = {
        role: message.role,
        content: message.content
      };
      if (message.toolCalls !== void 0 && message.toolCalls.length > 0) {
        renderedMessage.tool_calls = message.toolCalls.map(renderToolCall);
      }
      return renderedMessage;
    });
  }
};
var OpenAIToolRenderer = class {
  renderTools(tools) {
    return tools.map((tool) => {
      const toolDefinition = {
        type: "function",
        function: {
          name: tool.name,
          parameters: tool.inputSchema
        }
      };
      if (tool.description !== void 0) {
        toolDefinition.function.description = tool.description;
      }
      return toolDefinition;
    });
  }
};
var renderToolCall = (toolCall) => ({
  id: toolCall.id,
  type: "function",
  function: {
    name: toolCall.name,
    arguments: JSON.stringify(toolCall.input)
  }
});

// src/shared/response-normalizer.ts
var OpenAIResponseNormalizer = class {
  normalize(response) {
    const message = readMessage(response.body);
    if (!message) {
      return { type: "final", output: "" };
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      return {
        type: "tool_calls",
        toolCalls: message.tool_calls.flatMap((toolCall) => {
          if (!isOpenAIToolCall(toolCall)) {
            return [];
          }
          return [
            {
              id: toolCall.id,
              name: toolCall.function.name,
              input: parseToolArguments(toolCall.function.arguments)
            }
          ];
        })
      };
    }
    return { type: "final", output: extractText(message.content) };
  }
};
var readMessage = (body) => {
  if (!isRecord2(body)) {
    return null;
  }
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const [firstChoice] = choices;
  if (!isRecord2(firstChoice) || !isRecord2(firstChoice.message)) {
    return null;
  }
  return firstChoice.message;
};
var extractText = (content) => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.flatMap((chunk) => {
    if (!isRecord2(chunk)) {
      return [];
    }
    if (typeof chunk.text === "string") {
      return [chunk.text];
    }
    return [];
  }).join("");
};
var parseToolArguments = (argumentsText) => {
  if (argumentsText.length === 0) {
    return {};
  }
  try {
    return JSON.parse(argumentsText);
  } catch {
    return { raw: argumentsText };
  }
};
var isOpenAIToolCall = (value) => {
  if (!isRecord2(value) || !isRecord2(value.function)) {
    return false;
  }
  return typeof value.id === "string" && value.type === "function" && typeof value.function.name === "string" && typeof value.function.arguments === "string";
};
var isRecord2 = (value) => typeof value === "object" && value !== null;

// src/shared/sse-parser.ts
async function* parseSSEResponse(chunks) {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += typeof chunk.raw === "string" ? chunk.raw : String(chunk.raw);
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
      buffer = buffer.slice(newlineIdx + 1);
      if (line.length === 0) continue;
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") return;
      try {
        yield JSON.parse(data);
      } catch {
      }
    }
  }
}

// src/shared/adapter.ts
var OpenAICompatAdapter = class extends BaseModelAdapter {
  name;
  endpoint;
  prefix;
  errorNormalizer;
  responseNormalizer;
  messageRenderer;
  toolRenderer;
  constructor(provider, options) {
    super(provider);
    this.name = options.name;
    this.endpoint = options.endpoint;
    this.prefix = options.stripPrefix ?? `${options.name}:`;
    this.errorNormalizer = options.errorNormalizer ?? createErrorNormalizer(options.name);
    this.responseNormalizer = options.responseNormalizer ?? new OpenAIResponseNormalizer();
    this.messageRenderer = options.messageRenderer ?? new OpenAIChatMessageRenderer();
    this.toolRenderer = options.toolRenderer ?? new OpenAIToolRenderer();
  }
  toProviderRequest(request) {
    const systemPrompt = this.messageRenderer.renderSystemPrompt(request.systemPrompt);
    const renderedMessages = this.messageRenderer.renderMessages(request.messages);
    const renderedTools = this.toolRenderer.renderTools(request.tools);
    const model = request.model.startsWith(this.prefix) ? request.model.slice(this.prefix.length) : request.model;
    const body = {
      model,
      messages: systemPrompt === null ? renderedMessages : [systemPrompt, ...renderedMessages]
    };
    if (renderedTools.length > 0) body.tools = renderedTools;
    if (request.temperature !== void 0) body.temperature = request.temperature;
    if (request.maxTokens !== void 0) body.max_tokens = request.maxTokens;
    return {
      url: this.endpoint,
      headers: { "Content-Type": "application/json" },
      body,
      ...request.signal === void 0 ? {} : { signal: request.signal },
      ...request.metadata === void 0 ? {} : { metadata: request.metadata }
    };
  }
  fromProviderResponse(response, request) {
    if (response.status >= 400) throw response;
    const modelResponse = this.responseNormalizer.normalize(response);
    if (modelResponse.type === "final" && modelResponse.output.length === 0) {
      return {
        type: "final",
        output: "",
        metadata: { provider: this.name, model: request.model }
      };
    }
    return modelResponse;
  }
  normalizeError(error, request) {
    return this.errorNormalizer.normalize(error, request.model);
  }
  async *stream(request) {
    const streamProvider = this.streamingProvider;
    if (streamProvider === void 0) {
      throw new Error(`Provider "${this.name}" does not support streaming`);
    }
    yield* this.withErrorNormalization(request, this.doStream(request, streamProvider));
  }
  async *doStream(request, streamProvider) {
    const providerRequest = this.toProviderRequest(request);
    const body = providerRequest.body;
    body.stream = true;
    const toolCallAccumulators = /* @__PURE__ */ new Map();
    for await (const delta of parseSSEResponse(streamProvider.executeStream(providerRequest))) {
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
              arguments: ""
            });
          }
          const acc = toolCallAccumulators.get(idx);
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
              input: parseStreamToolArguments(acc.arguments)
            }
          };
        }
        toolCallAccumulators.clear();
      }
    }
    yield { type: "done" };
  }
};
var parseStreamToolArguments = (argumentsText) => {
  if (argumentsText.length === 0) {
    return {};
  }
  try {
    return JSON.parse(argumentsText);
  } catch {
    return { raw: argumentsText };
  }
};

// src/openai.ts
var createOpenAIProvider = (options) => {
  const httpProvider = new HttpProvider({
    name: "openai",
    authProvider: new ApiKeyAuthProvider(options.apiKey),
    ...options.timeoutMs === void 0 ? {} : { defaultTimeoutMs: options.timeoutMs }
  });
  return {
    name: "openai",
    adapter: new OpenAICompatAdapter(httpProvider, {
      name: "openai",
      endpoint: options.endpoint ?? "https://api.openai.com/v1/chat/completions"
    }),
    inferModel: inferOpenAI
  };
};
var inferOpenAI = (model) => {
  const lower = model.toLowerCase();
  if (lower.startsWith("gpt-") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4")) {
    return model;
  }
  return null;
};

// src/glm.ts
import { ApiKeyAuthProvider as ApiKeyAuthProvider2, HttpProvider as HttpProvider2 } from "@renx/model";
var DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
var DEFAULT_ENDPOINT_PATH = "/chat/completions";
var createGlmProvider = (options) => {
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL;
  const endpointPath = options.endpointPath ?? DEFAULT_ENDPOINT_PATH;
  const endpoint = `${trimTrailingSlash(baseURL)}${normalizePath(endpointPath)}`;
  const httpProvider = new HttpProvider2({
    name: "glm",
    authProvider: new ApiKeyAuthProvider2(options.apiKey),
    ...options.timeoutMs === void 0 ? {} : { defaultTimeoutMs: options.timeoutMs }
  });
  return {
    name: "glm",
    adapter: new OpenAICompatAdapter(httpProvider, {
      name: "glm",
      endpoint
    }),
    inferModel: inferGlm
  };
};
var inferGlm = (model) => {
  if (model.toLowerCase().startsWith("glm-")) {
    return model.toUpperCase();
  }
  return null;
};
var trimTrailingSlash = (value) => value.endsWith("/") ? value.slice(0, -1) : value;
var normalizePath = (value) => value.startsWith("/") ? value : `/${value}`;

// src/kimi.ts
import { ApiKeyAuthProvider as ApiKeyAuthProvider3, HttpProvider as HttpProvider3 } from "@renx/model";
var DEFAULT_BASE_URL2 = "https://api.moonshot.cn/v1";
var DEFAULT_ENDPOINT_PATH2 = "/chat/completions";
var createKimiProvider = (options) => {
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL2;
  const endpointPath = options.endpointPath ?? DEFAULT_ENDPOINT_PATH2;
  const endpoint = `${trimTrailingSlash2(baseURL)}${normalizePath2(endpointPath)}`;
  const httpProvider = new HttpProvider3({
    name: "kimi",
    authProvider: new ApiKeyAuthProvider3(options.apiKey),
    ...options.timeoutMs === void 0 ? {} : { defaultTimeoutMs: options.timeoutMs }
  });
  return {
    name: "kimi",
    adapter: new OpenAICompatAdapter(httpProvider, {
      name: "kimi",
      endpoint
    }),
    inferModel: inferKimi
  };
};
var inferKimi = (model) => {
  const lower = model.toLowerCase();
  if (lower.startsWith("moonshot-") || lower.startsWith("kimi-")) {
    return model;
  }
  return null;
};
var trimTrailingSlash2 = (value) => value.endsWith("/") ? value.slice(0, -1) : value;
var normalizePath2 = (value) => value.startsWith("/") ? value : `/${value}`;

// src/qwen.ts
import { ApiKeyAuthProvider as ApiKeyAuthProvider4, HttpProvider as HttpProvider4 } from "@renx/model";
var DEFAULT_BASE_URL3 = "https://dashscope.aliyuncs.com/compatible-mode/v1";
var DEFAULT_ENDPOINT_PATH3 = "/chat/completions";
var createQwenProvider = (options) => {
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL3;
  const endpointPath = options.endpointPath ?? DEFAULT_ENDPOINT_PATH3;
  const endpoint = `${trimTrailingSlash3(baseURL)}${normalizePath3(endpointPath)}`;
  const httpProvider = new HttpProvider4({
    name: "qwen",
    authProvider: new ApiKeyAuthProvider4(options.apiKey),
    ...options.timeoutMs === void 0 ? {} : { defaultTimeoutMs: options.timeoutMs }
  });
  return {
    name: "qwen",
    adapter: new OpenAICompatAdapter(httpProvider, {
      name: "qwen",
      endpoint
    }),
    inferModel: inferQwen
  };
};
var inferQwen = (model) => {
  const lower = model.toLowerCase();
  if (lower.startsWith("qwen-")) {
    return model;
  }
  return null;
};
var trimTrailingSlash3 = (value) => value.endsWith("/") ? value.slice(0, -1) : value;
var normalizePath3 = (value) => value.startsWith("/") ? value : `/${value}`;

// src/openrouter.ts
import { ApiKeyAuthProvider as ApiKeyAuthProvider5, HttpProvider as HttpProvider5 } from "@renx/model";
var DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
var createOpenRouterProvider = (options) => {
  const httpProvider = new HttpProvider5({
    name: "openrouter",
    authProvider: new ApiKeyAuthProvider5(options.apiKey),
    ...options.timeoutMs === void 0 ? {} : { defaultTimeoutMs: options.timeoutMs }
  });
  return {
    name: "openrouter",
    adapter: new OpenAICompatAdapter(httpProvider, {
      name: "openrouter",
      endpoint: options.endpoint ?? DEFAULT_ENDPOINT
    }),
    inferModel: inferOpenRouter
  };
};
var inferOpenRouter = (model) => {
  return model;
};

// src/minimax.ts
import { ApiKeyAuthProvider as ApiKeyAuthProvider6, HttpProvider as HttpProvider6 } from "@renx/model";
var DEFAULT_BASE_URL4 = "https://api.minimax.io/v1";
var DEFAULT_ENDPOINT_PATH4 = "/chat/completions";
var createMiniMaxProvider = (options) => {
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL4;
  const endpointPath = options.endpointPath ?? DEFAULT_ENDPOINT_PATH4;
  const endpoint = `${trimTrailingSlash4(baseURL)}${normalizePath4(endpointPath)}`;
  const httpProvider = new HttpProvider6({
    name: "minimax",
    authProvider: new ApiKeyAuthProvider6(options.apiKey),
    ...options.timeoutMs === void 0 ? {} : { defaultTimeoutMs: options.timeoutMs }
  });
  return {
    name: "minimax",
    adapter: new OpenAICompatAdapter(httpProvider, {
      name: "minimax",
      endpoint
    }),
    inferModel: inferMiniMax
  };
};
var inferMiniMax = (model) => {
  const lower = model.toLowerCase();
  if (lower.startsWith("minimax-") || lower.startsWith("m2-") || lower.startsWith("abab")) {
    return model;
  }
  return null;
};
var trimTrailingSlash4 = (value) => value.endsWith("/") ? value.slice(0, -1) : value;
var normalizePath4 = (value) => value.startsWith("/") ? value : `/${value}`;
export {
  OpenAIChatMessageRenderer,
  OpenAICompatAdapter,
  OpenAIResponseNormalizer,
  OpenAIToolRenderer,
  createErrorNormalizer,
  createGlmProvider,
  createInferResolver,
  createKimiProvider,
  createMiniMaxProvider,
  createModelClient,
  createOpenAIProvider,
  createOpenRouterProvider,
  createPrefixResolver,
  createQwenProvider,
  parseSSEResponse
};
//# sourceMappingURL=index.js.map
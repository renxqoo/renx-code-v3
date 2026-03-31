import {
  OpenAIMessageRenderer,
  OpenAIResponseNormalizer,
  OpenAIToolRenderer
} from "./chunk-WUXLEIKS.js";

// src/openai/adapter.ts
import {
  BaseModelAdapter
} from "@renx/model";

// src/openai/error-normalizer.ts
import {
  createNormalizedModelError,
  HttpProviderError
} from "@renx/model";
var OpenAIErrorNormalizer = class {
  normalize(error, model) {
    const envelope = unwrapEnvelope(error, model);
    const resolvedError = envelope.error;
    if (resolvedError instanceof HttpProviderError) {
      return normalizeProviderResponse(
        "openai",
        resolvedError.response,
        envelope.model,
        resolvedError
      );
    }
    if (isProviderResponse(resolvedError)) {
      return normalizeProviderResponse("openai", resolvedError, envelope.model);
    }
    if (resolvedError instanceof TypeError) {
      return createNormalizedModelError({
        message: resolvedError.message,
        provider: "openai",
        code: "NETWORK_ERROR",
        retryable: true,
        retryMode: "BACKOFF",
        raw: resolvedError,
        cause: resolvedError,
        ...envelope.model === void 0 ? {} : { model: envelope.model }
      });
    }
    if (resolvedError instanceof Error) {
      const isTimeout = resolvedError.name === "TimeoutError" || resolvedError.name === "AbortError";
      return createNormalizedModelError({
        message: resolvedError.message,
        provider: "openai",
        code: isTimeout ? "TIMEOUT" : "UNKNOWN",
        retryable: isTimeout,
        retryMode: isTimeout ? "BACKOFF" : "NONE",
        raw: resolvedError,
        cause: resolvedError,
        ...envelope.model === void 0 ? {} : { model: envelope.model }
      });
    }
    return createNormalizedModelError({
      message: "Unknown OpenAI provider error",
      provider: "openai",
      code: "UNKNOWN",
      retryable: false,
      retryMode: "NONE",
      raw: resolvedError,
      ...envelope.model === void 0 ? {} : { model: envelope.model }
    });
  }
};
var unwrapEnvelope = (input, model) => {
  if (!isRecord(input) || !("error" in input)) {
    return {
      error: input,
      ...model === void 0 ? {} : { model }
    };
  }
  const resolvedModel = typeof input.model === "string" ? input.model : model;
  return {
    error: input.error,
    ...resolvedModel === void 0 ? {} : { model: resolvedModel }
  };
};
var normalizeProviderResponse = (provider, response, model, cause) => {
  const payload = readErrorPayload(response.body);
  const message = payload.message ?? `OpenAI request failed with status ${response.status}`;
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
  if (httpStatus === 401) {
    return { code: "AUTH_ERROR", retryable: false, retryMode: "NONE" };
  }
  if (httpStatus === 403) {
    return { code: "PERMISSION_DENIED", retryable: false, retryMode: "NONE" };
  }
  if (httpStatus === 408) {
    return { code: "TIMEOUT", retryable: true, retryMode: "BACKOFF" };
  }
  if (httpStatus === 429) {
    return {
      code: "RATE_LIMIT",
      retryable: true,
      retryMode: retryAfterMs === void 0 ? "BACKOFF" : "AFTER_DELAY"
    };
  }
  if (httpStatus >= 500) {
    return { code: "SERVER_ERROR", retryable: true, retryMode: "BACKOFF" };
  }
  if (httpStatus === 400 && isContextOverflow(message)) {
    return {
      code: "CONTEXT_OVERFLOW",
      retryable: true,
      retryMode: "TRANSFORM_AND_RETRY"
    };
  }
  return { code: "UNKNOWN", retryable: false, retryMode: "NONE" };
};
var isContextOverflow = (message) => {
  const normalized = message.toLowerCase();
  return normalized.includes("context length") || normalized.includes("maximum context length");
};
var parseRetryAfter = (headerValue) => {
  if (headerValue === void 0) {
    return void 0;
  }
  const seconds = Number(headerValue);
  return Number.isNaN(seconds) ? void 0 : seconds * 1e3;
};
var readErrorPayload = (body) => {
  if (!isRecord(body) || !isRecord(body.error)) {
    return {};
  }
  return {
    ...typeof body.error.message === "string" ? { message: body.error.message } : {},
    ...typeof body.error.code === "string" || typeof body.error.code === "number" ? { code: body.error.code } : {},
    ...typeof body.error.type === "string" ? { type: body.error.type } : {}
  };
};
var isProviderResponse = (value) => {
  return isRecord(value) && typeof value.status === "number" && isRecord(value.headers) && "body" in value;
};
var isRecord = (value) => {
  return typeof value === "object" && value !== null;
};

// src/openai/adapter.ts
var OpenAIModelAdapter = class extends BaseModelAdapter {
  name = "openai";
  endpoint;
  errorNormalizer;
  responseNormalizer;
  messageRenderer;
  toolRenderer;
  constructor(provider, options = {}) {
    super(provider);
    this.endpoint = options.endpoint ?? "https://api.openai.com/v1/chat/completions";
    this.errorNormalizer = options.errorNormalizer ?? new OpenAIErrorNormalizer();
    this.responseNormalizer = options.responseNormalizer ?? new OpenAIResponseNormalizer();
    this.messageRenderer = options.messageRenderer ?? new OpenAIMessageRenderer();
    this.toolRenderer = options.toolRenderer ?? new OpenAIToolRenderer();
  }
  toProviderRequest(request) {
    const systemPrompt = this.messageRenderer.renderSystemPrompt(request.systemPrompt);
    const renderedMessages = this.messageRenderer.renderMessages(request.messages);
    const renderedTools = this.toolRenderer.renderTools(request.tools);
    const body = {
      model: stripOpenAIPrefix(request.model),
      messages: systemPrompt === null ? renderedMessages : [systemPrompt, ...renderedMessages]
    };
    if (renderedTools.length > 0) {
      body.tools = renderedTools;
    }
    if (request.temperature !== void 0) {
      body.temperature = request.temperature;
    }
    if (request.maxTokens !== void 0) {
      body.max_tokens = request.maxTokens;
    }
    return {
      url: this.endpoint,
      headers: {
        "Content-Type": "application/json"
      },
      body,
      ...request.metadata === void 0 ? {} : { metadata: request.metadata }
    };
  }
  fromProviderResponse(response, request) {
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
          model: request.model
        }
      };
    }
    return modelResponse;
  }
  normalizeError(error, request) {
    return this.errorNormalizer.normalize(error, request.model);
  }
};
var stripOpenAIPrefix = (model) => {
  return model.startsWith("openai:") ? model.slice("openai:".length) : model;
};

// src/openai/provider.ts
import { ApiKeyAuthProvider, HttpProvider } from "@renx/model";
var createOpenAIProvider = (options) => {
  const provider = new HttpProvider({
    name: "openai",
    authProvider: new ApiKeyAuthProvider(options.apiKey),
    ...options.timeoutMs === void 0 ? {} : { defaultTimeoutMs: options.timeoutMs }
  });
  const adapterOptions = options.endpoint === void 0 ? void 0 : { endpoint: options.endpoint };
  return {
    name: "openai",
    adapter: new OpenAIModelAdapter(provider, adapterOptions)
  };
};

export {
  OpenAIErrorNormalizer,
  OpenAIModelAdapter,
  createOpenAIProvider
};
//# sourceMappingURL=chunk-WDUX57AT.js.map
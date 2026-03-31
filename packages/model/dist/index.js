// src/adapter.ts
var BaseModelAdapter = class {
  constructor(provider) {
    this.provider = provider;
  }
  async generate(request) {
    try {
      const providerRequest = await this.toProviderRequest(request);
      const providerResponse = await this.provider.execute(providerRequest);
      return await this.fromProviderResponse(providerResponse, request);
    } catch (error) {
      throw await this.normalizeError(error, request);
    }
  }
  async describeRequest(request) {
    const providerRequest = await this.toProviderRequest(request);
    return {
      endpoint: providerRequest.url,
      method: providerRequest.method ?? "POST"
    };
  }
};

// src/retry.ts
var DEFAULT_MODEL_RETRY_OPTIONS = {
  maxAttempts: 3,
  baseDelayMs: 300,
  maxDelayMs: 5e3,
  maxRetryAfterMs: 3e4
};
var resolveModelRetryOptions = (options) => {
  if (options === false) {
    return false;
  }
  return {
    maxAttempts: options?.maxAttempts ?? DEFAULT_MODEL_RETRY_OPTIONS.maxAttempts,
    baseDelayMs: options?.baseDelayMs ?? DEFAULT_MODEL_RETRY_OPTIONS.baseDelayMs,
    maxDelayMs: options?.maxDelayMs ?? DEFAULT_MODEL_RETRY_OPTIONS.maxDelayMs,
    maxRetryAfterMs: options?.maxRetryAfterMs ?? DEFAULT_MODEL_RETRY_OPTIONS.maxRetryAfterMs,
    ...options?.transformRequest === void 0 ? {} : { transformRequest: options.transformRequest },
    ...options?.selectFallbackModel === void 0 ? {} : { selectFallbackModel: options.selectFallbackModel }
  };
};
var isNormalizedModelError = (error) => {
  return isRecord(error) && typeof error.message === "string" && typeof error.provider === "string" && typeof error.code === "string" && typeof error.retryable === "boolean" && typeof error.retryMode === "string" && "raw" in error;
};
var planModelRetry = async (context, options) => {
  if (!context.error.retryable) {
    return null;
  }
  if (context.attempt >= options.maxAttempts) {
    return null;
  }
  switch (context.error.retryMode) {
    case "IMMEDIATE":
      return {
        request: context.request,
        delayMs: 0
      };
    case "BACKOFF":
      return {
        request: context.request,
        delayMs: computeBackoffDelayMs(context.attempt, options)
      };
    case "AFTER_DELAY":
      return {
        request: context.request,
        delayMs: clampRetryAfterDelay(context.error.retryAfterMs, context.attempt, options)
      };
    case "TRANSFORM_AND_RETRY": {
      if (options.transformRequest === void 0) {
        return null;
      }
      const transformedRequest = await options.transformRequest(context);
      if (transformedRequest === null) {
        return null;
      }
      return {
        request: transformedRequest,
        delayMs: 0
      };
    }
    case "FALLBACK_MODEL": {
      if (options.selectFallbackModel === void 0) {
        return null;
      }
      const fallbackModel = await options.selectFallbackModel(context);
      if (fallbackModel === null) {
        return null;
      }
      return {
        request: {
          ...context.request,
          model: fallbackModel
        },
        delayMs: 0
      };
    }
    default:
      return null;
  }
};
var sleep = async (delayMs) => {
  if (delayMs <= 0) {
    return;
  }
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
};
var computeBackoffDelayMs = (attempt, options) => {
  return Math.min(options.baseDelayMs * 2 ** (attempt - 1), options.maxDelayMs);
};
var clampRetryAfterDelay = (retryAfterMs, attempt, options) => {
  if (retryAfterMs === void 0) {
    return computeBackoffDelayMs(attempt, options);
  }
  return Math.min(retryAfterMs, options.maxRetryAfterMs);
};
var isRecord = (value) => {
  return typeof value === "object" && value !== null;
};

// src/client.ts
var DefaultModelClient = class {
  providers = /* @__PURE__ */ new Map();
  resolveModelEntry;
  retryOptions;
  constructor(options) {
    for (const provider of options.providers) {
      this.providers.set(provider.name, provider.adapter);
    }
    this.resolveModelEntry = options.resolveModel;
    this.retryOptions = resolveModelRetryOptions(options.retry);
  }
  async generate(request) {
    const maxAttempts = this.retryOptions === false ? 1 : this.retryOptions.maxAttempts;
    const observer = request.observer;
    let currentRequest = request;
    for (let attempt = 1; ; attempt += 1) {
      const resolved = this.resolveAdapterModel(currentRequest.model);
      const providerRequest = toProviderModelRequest(currentRequest, resolved.model);
      const requestDescriptor = await describeRequest(resolved.adapter, providerRequest);
      const requestSummary = createObserverRequest(providerRequest, requestDescriptor);
      await this.observe(
        {
          status: "attempting",
          attempt,
          maxAttempts,
          logicalModel: resolved.model.logicalModel,
          provider: resolved.model.provider,
          providerModel: resolved.model.providerModel,
          request: requestSummary
        },
        observer
      );
      try {
        const response = await resolved.adapter.generate(providerRequest);
        await this.observe(
          {
            status: "success",
            attempt,
            maxAttempts,
            logicalModel: resolved.model.logicalModel,
            provider: resolved.model.provider,
            providerModel: resolved.model.providerModel,
            request: requestSummary,
            responseType: response.type
          },
          observer
        );
        return response;
      } catch (error) {
        if (this.retryOptions === false || !isNormalizedModelError(error)) {
          await this.observe(
            {
              status: "failed",
              attempt,
              maxAttempts,
              logicalModel: resolved.model.logicalModel,
              provider: resolved.model.provider,
              providerModel: resolved.model.providerModel,
              request: requestSummary,
              ...isNormalizedModelError(error) ? { error: toObserverError(error) } : { error: toUnknownObserverError(error) }
            },
            observer
          );
          throw error;
        }
        const context = createRetryContext(
          attempt,
          this.retryOptions.maxAttempts,
          currentRequest,
          resolved.model,
          error
        );
        const plannedRetry = await planModelRetry(context, this.retryOptions);
        if (plannedRetry === null) {
          await this.observe(
            {
              status: "failed",
              attempt,
              maxAttempts,
              logicalModel: resolved.model.logicalModel,
              provider: resolved.model.provider,
              providerModel: resolved.model.providerModel,
              request: requestSummary,
              error: toObserverError(error)
            },
            observer
          );
          throw error;
        }
        await this.observe(
          {
            status: "retrying",
            attempt,
            maxAttempts,
            logicalModel: resolved.model.logicalModel,
            provider: resolved.model.provider,
            providerModel: resolved.model.providerModel,
            request: requestSummary,
            delayMs: plannedRetry.delayMs,
            error: toObserverError(error)
          },
          observer
        );
        await sleep(plannedRetry.delayMs);
        currentRequest = plannedRetry.request;
      }
    }
  }
  resolve(model) {
    return this.resolveAdapterModel(model).model;
  }
  resolveAdapterModel(model) {
    const registeredModel = this.resolveModelEntry(model);
    const adapter = this.providers.get(registeredModel.provider);
    if (!adapter) {
      throw new Error(`Provider not found: ${registeredModel.provider}`);
    }
    return {
      adapter,
      model: {
        logicalModel: registeredModel.id,
        provider: registeredModel.provider,
        providerModel: registeredModel.providerModel,
        ...registeredModel.capabilities === void 0 ? {} : { capabilities: registeredModel.capabilities },
        ...registeredModel.metadata === void 0 ? {} : { metadata: registeredModel.metadata }
      }
    };
  }
  async observe(state, observer) {
    if (observer === void 0) {
      return;
    }
    try {
      await observer(state);
    } catch {
    }
  }
};
var createModelClient = (options) => {
  return new DefaultModelClient(options);
};
var toProviderModelRequest = (request, model) => {
  const { observer: _observer, ...requestPayload } = request;
  return {
    ...requestPayload,
    model: model.providerModel,
    metadata: {
      ...requestPayload.metadata,
      logicalModel: model.logicalModel,
      provider: model.provider,
      providerModel: model.providerModel
    }
  };
};
var createRetryContext = (attempt, maxAttempts, request, model, error) => {
  return {
    attempt,
    maxAttempts,
    request,
    error,
    logicalModel: model.logicalModel,
    provider: model.provider,
    providerModel: model.providerModel
  };
};
var createObserverRequest = (request, requestDescriptor) => {
  return {
    ...requestDescriptor === void 0 ? {} : requestDescriptor,
    messageCount: request.messages.length,
    toolCount: request.tools.length,
    hasSystemPrompt: request.systemPrompt.trim().length > 0,
    ...request.temperature === void 0 ? {} : { temperature: request.temperature },
    ...request.maxTokens === void 0 ? {} : { maxTokens: request.maxTokens }
  };
};
var describeRequest = async (adapter, request) => {
  if (adapter.describeRequest === void 0) {
    return void 0;
  }
  const descriptor = await adapter.describeRequest(request);
  return {
    endpoint: descriptor.endpoint,
    ...descriptor.method === void 0 ? {} : { method: descriptor.method }
  };
};
var toObserverError = (error) => {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    retryMode: error.retryMode,
    ...error.retryAfterMs === void 0 ? {} : { retryAfterMs: error.retryAfterMs },
    ...error.httpStatus === void 0 ? {} : { httpStatus: error.httpStatus },
    ...error.rawCode === void 0 ? {} : { rawCode: error.rawCode },
    ...error.rawType === void 0 ? {} : { rawType: error.rawType }
  };
};
var toUnknownObserverError = (error) => {
  if (error instanceof Error) {
    return {
      code: "UNKNOWN",
      message: error.message,
      retryable: false,
      retryMode: "NONE"
    };
  }
  return {
    code: "UNKNOWN",
    message: "Unknown model error",
    retryable: false,
    retryMode: "NONE"
  };
};

// src/errors.ts
var ModelError = class extends Error {
  provider;
  model;
  code;
  retryable;
  retryMode;
  retryAfterMs;
  httpStatus;
  rawCode;
  rawType;
  raw;
  constructor(init) {
    super(init.message);
    this.name = "ModelError";
    this.provider = init.provider;
    this.code = init.code;
    this.retryable = init.retryable;
    this.retryMode = init.retryMode;
    this.raw = init.raw;
    if (init.model !== void 0) {
      this.model = init.model;
    }
    if (init.retryAfterMs !== void 0) {
      this.retryAfterMs = init.retryAfterMs;
    }
    if (init.httpStatus !== void 0) {
      this.httpStatus = init.httpStatus;
    }
    if (init.rawCode !== void 0) {
      this.rawCode = init.rawCode;
    }
    if (init.rawType !== void 0) {
      this.rawType = init.rawType;
    }
    if (init.cause !== void 0) {
      this.cause = init.cause;
    }
  }
};
var createNormalizedModelError = (init) => {
  return new ModelError(init);
};

// src/http/auth-provider.ts
var StaticHeaderAuthProvider = class {
  constructor(headers) {
    this.headers = headers;
  }
  getHeaders() {
    return { ...this.headers };
  }
};
var ApiKeyAuthProvider = class {
  constructor(apiKey, headerName = "Authorization", scheme = "Bearer") {
    this.apiKey = apiKey;
    this.headerName = headerName;
    this.scheme = scheme;
  }
  getHeaders() {
    const value = this.scheme.length > 0 ? `${this.scheme} ${this.apiKey}` : this.apiKey;
    return {
      [this.headerName]: value
    };
  }
};

// src/http/http-provider.ts
var HttpProviderError = class extends Error {
  constructor(message, response) {
    super(message);
    this.response = response;
    this.name = "HttpProviderError";
  }
};
var HttpProvider = class {
  name;
  authProvider;
  defaultTimeoutMs;
  fetchImpl;
  constructor(options = {}) {
    this.name = options.name ?? "http";
    this.authProvider = options.authProvider;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 3e4;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }
  async execute(request) {
    const authHeaders = this.authProvider ? await this.authProvider.getHeaders() : {};
    const response = await this.fetchImpl(request.url, {
      method: request.method ?? "POST",
      headers: {
        ...authHeaders,
        ...request.headers
      },
      body: serializeRequestBody(request.body),
      signal: AbortSignal.timeout(request.timeoutMs ?? this.defaultTimeoutMs)
    });
    const parsedBody = await parseResponseBody(response);
    const providerResponse = {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: parsedBody,
      raw: parsedBody
    };
    if (!response.ok) {
      throw new HttpProviderError(
        `Provider request failed with status ${response.status}`,
        providerResponse
      );
    }
    return providerResponse;
  }
};
var serializeRequestBody = (body) => {
  return typeof body === "string" ? body : JSON.stringify(body);
};
var parseResponseBody = async (response) => {
  const rawText = await response.text();
  if (rawText.length === 0) {
    return null;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(rawText);
    } catch {
      return rawText;
    }
  }
  return rawText;
};
export {
  ApiKeyAuthProvider,
  BaseModelAdapter,
  DEFAULT_MODEL_RETRY_OPTIONS,
  DefaultModelClient,
  HttpProvider,
  HttpProviderError,
  ModelError,
  StaticHeaderAuthProvider,
  createModelClient,
  createNormalizedModelError,
  isNormalizedModelError,
  planModelRetry,
  resolveModelRetryOptions,
  sleep
};
//# sourceMappingURL=index.js.map
import type { ModelAdapter } from "./adapter";
import type { NormalizedModelError } from "./errors";
import type {
  ModelObserver,
  ModelObserverError,
  ModelObserverRequest,
  ModelObserverState,
} from "./observer";
import {
  type ModelRetryContext,
  type ModelRetryOptions,
  type ResolvedModelRetryOptions,
  planModelRetry,
  resolveModelRetryOptions,
  sleep,
  isNormalizedModelError,
} from "./retry";
import type {
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  RegisteredModel,
  ResolvedModel,
} from "./types";

export interface ModelClient {
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
  resolve(model: string): ResolvedModel;
}

export interface ModelBinding {
  client: ModelClient;
  name: string;
}

export interface ModelProvider {
  name: string;
  adapter: ModelAdapter;
  inferModel?: (model: string) => string | null;
}

export type ModelResolver = (model: string) => RegisteredModel;

export interface CreateModelClientOptions {
  providers: ModelProvider[];
  resolveModel: ModelResolver;
  retry?: ModelRetryOptions | false;
}

interface ResolvedAdapterModel {
  adapter: ModelAdapter;
  model: ResolvedModel;
}

type ObserverBase = {
  attempt: number;
  maxAttempts: number;
  logicalModel: string;
  provider: string;
  providerModel: string;
  request: ModelObserverRequest;
};

export class DefaultModelClient implements ModelClient {
  private readonly providers = new Map<string, ModelAdapter>();
  private readonly resolveModelEntry: ModelResolver;
  private readonly retryOptions: ResolvedModelRetryOptions | false;

  constructor(options: CreateModelClientOptions) {
    for (const provider of options.providers) {
      this.providers.set(provider.name, provider.adapter);
    }

    this.resolveModelEntry = options.resolveModel;
    this.retryOptions = resolveModelRetryOptions(options.retry);
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const maxAttempts = this.retryOptions === false ? 1 : this.retryOptions.maxAttempts;
    const observer = request.observer;
    let currentRequest = request;

    for (let attempt = 1; ; attempt += 1) {
      const resolved = this.resolveAdapterModel(currentRequest.model);
      const providerRequest = toProviderModelRequest(currentRequest, resolved.model);
      const requestDescriptor = await describeRequest(resolved.adapter, providerRequest);
      const requestSummary = createObserverRequest(providerRequest, requestDescriptor);
      const base = this.observerBase(attempt, maxAttempts, resolved.model, requestSummary);

      await this.observe({ ...base, status: "attempting" }, observer);

      try {
        const response = await resolved.adapter.generate(providerRequest);

        await this.observe({ ...base, status: "success", responseType: response.type }, observer);

        return response;
      } catch (error) {
        if (this.retryOptions === false || !isNormalizedModelError(error)) {
          await this.observe(
            {
              ...base,
              status: "failed",
              ...(isNormalizedModelError(error)
                ? { error: toObserverError(error) }
                : { error: toUnknownObserverError(error) }),
            },
            observer,
          );

          throw error;
        }

        const context = createRetryContext(
          attempt,
          this.retryOptions.maxAttempts,
          currentRequest,
          resolved.model,
          error,
        );
        const plannedRetry = await planModelRetry(context, this.retryOptions);

        if (plannedRetry === null) {
          await this.observe(
            { ...base, status: "failed", error: toObserverError(error) },
            observer,
          );

          throw error;
        }

        await this.observe(
          {
            ...base,
            status: "retrying",
            delayMs: plannedRetry.delayMs,
            error: toObserverError(error),
          },
          observer,
        );

        await sleep(plannedRetry.delayMs);
        currentRequest = plannedRetry.request;
      }
    }
  }

  resolve(model: string): ResolvedModel {
    return this.resolveAdapterModel(model).model;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const maxAttempts = this.retryOptions === false ? 1 : this.retryOptions.maxAttempts;
    const observer = request.observer;
    let currentRequest = request;

    // Phase 1: Retry loop for connection — only before first event is yielded
    let iterator: AsyncIterator<ModelStreamEvent> | undefined;

    for (let attempt = 1; iterator === undefined; attempt += 1) {
      const resolved = this.resolveAdapterModel(currentRequest.model);

      if (resolved.adapter.stream === undefined) {
        throw new Error(`Streaming not supported for model: ${currentRequest.model}`);
      }

      const providerRequest = toProviderModelRequest(currentRequest, resolved.model);
      const requestDescriptor = await describeRequest(resolved.adapter, providerRequest);
      const requestSummary = createObserverRequest(providerRequest, requestDescriptor);
      const base = this.observerBase(attempt, maxAttempts, resolved.model, requestSummary);

      await this.observe({ ...base, status: "attempting" }, observer);

      const iterable = resolved.adapter.stream(providerRequest);
      const candidate = iterable[Symbol.asyncIterator]();

      try {
        const result = await candidate.next();

        await this.observe({ ...base, status: "success", responseType: "stream" }, observer);

        if (!result.done) {
          yield result.value;
        }

        iterator = candidate;
      } catch (error) {
        if (
          attempt >= maxAttempts ||
          this.retryOptions === false ||
          !isNormalizedModelError(error)
        ) {
          await this.observe(
            {
              ...base,
              status: "failed",
              ...(isNormalizedModelError(error)
                ? { error: toObserverError(error) }
                : { error: toUnknownObserverError(error) }),
            },
            observer,
          );

          throw error;
        }

        const context = createRetryContext(
          attempt,
          this.retryOptions.maxAttempts,
          currentRequest,
          resolved.model,
          error,
        );
        const plannedRetry = await planModelRetry(context, this.retryOptions);

        if (plannedRetry === null) {
          await this.observe(
            { ...base, status: "failed", error: toObserverError(error) },
            observer,
          );

          throw error;
        }

        await this.observe(
          {
            ...base,
            status: "retrying",
            delayMs: plannedRetry.delayMs,
            error: toObserverError(error),
          },
          observer,
        );

        await sleep(plannedRetry.delayMs);
        currentRequest = plannedRetry.request;
      }
    }

    // Phase 2: Yield remaining events without retry (mid-stream)
    while (true) {
      const result = await iterator!.next();

      if (result.done) break;

      yield result.value;
    }
  }

  private resolveAdapterModel(model: string): ResolvedAdapterModel {
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
        ...(registeredModel.capabilities === undefined
          ? {}
          : { capabilities: registeredModel.capabilities }),
        ...(registeredModel.metadata === undefined ? {} : { metadata: registeredModel.metadata }),
      },
    };
  }

  private observerBase(
    attempt: number,
    maxAttempts: number,
    model: ResolvedModel,
    request: ModelObserverRequest,
  ): ObserverBase {
    return {
      attempt,
      maxAttempts,
      logicalModel: model.logicalModel,
      provider: model.provider,
      providerModel: model.providerModel,
      request,
    };
  }

  private async observe(state: ModelObserverState, observer?: ModelObserver): Promise<void> {
    if (observer === undefined) {
      return;
    }

    try {
      await observer(state);
    } catch (observerError) {
      console.error("[ModelClient] Observer error:", observerError);
    }
  }
}

export const createModelClient = (options: CreateModelClientOptions): ModelClient => {
  return new DefaultModelClient(options);
};

export const createModelBinding = (client: ModelClient, name: string): ModelBinding => ({
  client,
  name,
});

let defaultModelClient: ModelClient | undefined;

export const setDefaultModelClient = (client: ModelClient): void => {
  defaultModelClient = client;
};

export const getDefaultModelClient = (): ModelClient | undefined => defaultModelClient;

export const clearDefaultModelClient = (): void => {
  defaultModelClient = undefined;
};

const toProviderModelRequest = (request: ModelRequest, model: ResolvedModel): ModelRequest => {
  const { observer: _observer, ...requestPayload } = request;

  return {
    ...requestPayload,
    model: model.providerModel,
    metadata: {
      ...requestPayload.metadata,
      logicalModel: model.logicalModel,
      provider: model.provider,
      providerModel: model.providerModel,
    },
  };
};

const createRetryContext = (
  attempt: number,
  maxAttempts: number,
  request: ModelRequest,
  model: ResolvedModel,
  error: NormalizedModelError,
): ModelRetryContext => {
  return {
    attempt,
    maxAttempts,
    request,
    error,
    logicalModel: model.logicalModel,
    provider: model.provider,
    providerModel: model.providerModel,
  };
};

const createObserverRequest = (
  request: ModelRequest,
  requestDescriptor: Awaited<ReturnType<typeof describeRequest>>,
): ModelObserverRequest => {
  return {
    ...(requestDescriptor === undefined ? {} : requestDescriptor),
    messageCount: request.messages.length,
    toolCount: request.tools.length,
    hasSystemPrompt: request.systemPrompt.trim().length > 0,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
  };
};

const describeRequest = async (
  adapter: ModelAdapter,
  request: ModelRequest,
): Promise<Pick<ModelObserverRequest, "endpoint" | "method"> | undefined> => {
  if (adapter.describeRequest === undefined) {
    return undefined;
  }

  const descriptor = await adapter.describeRequest(request);

  return {
    endpoint: descriptor.endpoint,
    ...(descriptor.method === undefined ? {} : { method: descriptor.method }),
  };
};

const toObserverError = (error: NormalizedModelError): ModelObserverError => {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    retryMode: error.retryMode,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    ...(error.rawCode === undefined ? {} : { rawCode: error.rawCode }),
    ...(error.rawType === undefined ? {} : { rawType: error.rawType }),
  };
};

const toUnknownObserverError = (error: unknown): ModelObserverError => {
  if (error instanceof Error) {
    return {
      code: "UNKNOWN",
      message: error.message,
      retryable: false,
      retryMode: "NONE",
    };
  }

  return {
    code: "UNKNOWN",
    message: "Unknown model error",
    retryable: false,
    retryMode: "NONE",
  };
};

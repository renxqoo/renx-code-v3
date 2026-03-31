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
import type { ModelRequest, ModelResponse, RegisteredModel, ResolvedModel } from "./types";

export interface ModelClient {
  generate(request: ModelRequest): Promise<ModelResponse>;
  resolve(model: string): ResolvedModel;
}

export interface ModelProvider {
  name: string;
  adapter: ModelAdapter;
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

      await this.observe(
        {
          status: "attempting",
          attempt,
          maxAttempts,
          logicalModel: resolved.model.logicalModel,
          provider: resolved.model.provider,
          providerModel: resolved.model.providerModel,
          request: requestSummary,
        },
        observer,
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
            responseType: response.type,
          },
          observer,
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
            {
              status: "failed",
              attempt,
              maxAttempts,
              logicalModel: resolved.model.logicalModel,
              provider: resolved.model.provider,
              providerModel: resolved.model.providerModel,
              request: requestSummary,
              error: toObserverError(error),
            },
            observer,
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

  private async observe(state: ModelObserverState, observer?: ModelObserver): Promise<void> {
    if (observer === undefined) {
      return;
    }

    try {
      await observer(state);
    } catch {}
  }
}

export const createModelClient = (options: CreateModelClientOptions): ModelClient => {
  return new DefaultModelClient(options);
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

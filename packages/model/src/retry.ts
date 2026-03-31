import type { NormalizedModelError } from "./errors";
import type { ModelRequest } from "./types";

export interface ModelRetryContext {
  attempt: number;
  maxAttempts: number;
  request: ModelRequest;
  error: NormalizedModelError;
  logicalModel: string;
  provider: string;
  providerModel: string;
}

export interface ModelRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetryAfterMs?: number;
  transformRequest?:
    | ((context: ModelRetryContext) => Promise<ModelRequest | null> | ModelRequest | null)
    | undefined;
  selectFallbackModel?:
    | ((context: ModelRetryContext) => Promise<string | null> | string | null)
    | undefined;
}

export interface ResolvedModelRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetryAfterMs: number;
  transformRequest?: ModelRetryOptions["transformRequest"];
  selectFallbackModel?: ModelRetryOptions["selectFallbackModel"];
}

export interface PlannedModelRetry {
  request: ModelRequest;
  delayMs: number;
}

export const DEFAULT_MODEL_RETRY_OPTIONS: ResolvedModelRetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 300,
  maxDelayMs: 5_000,
  maxRetryAfterMs: 30_000,
};

export const resolveModelRetryOptions = (
  options?: ModelRetryOptions | false,
): ResolvedModelRetryOptions | false => {
  if (options === false) {
    return false;
  }

  return {
    maxAttempts: options?.maxAttempts ?? DEFAULT_MODEL_RETRY_OPTIONS.maxAttempts,
    baseDelayMs: options?.baseDelayMs ?? DEFAULT_MODEL_RETRY_OPTIONS.baseDelayMs,
    maxDelayMs: options?.maxDelayMs ?? DEFAULT_MODEL_RETRY_OPTIONS.maxDelayMs,
    maxRetryAfterMs: options?.maxRetryAfterMs ?? DEFAULT_MODEL_RETRY_OPTIONS.maxRetryAfterMs,
    ...(options?.transformRequest === undefined
      ? {}
      : { transformRequest: options.transformRequest }),
    ...(options?.selectFallbackModel === undefined
      ? {}
      : { selectFallbackModel: options.selectFallbackModel }),
  };
};

export const isNormalizedModelError = (error: unknown): error is NormalizedModelError => {
  return (
    isRecord(error) &&
    typeof error.message === "string" &&
    typeof error.provider === "string" &&
    typeof error.code === "string" &&
    typeof error.retryable === "boolean" &&
    typeof error.retryMode === "string" &&
    "raw" in error
  );
};

export const planModelRetry = async (
  context: ModelRetryContext,
  options: ResolvedModelRetryOptions,
): Promise<PlannedModelRetry | null> => {
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
        delayMs: 0,
      };
    case "BACKOFF":
      return {
        request: context.request,
        delayMs: computeBackoffDelayMs(context.attempt, options),
      };
    case "AFTER_DELAY":
      return {
        request: context.request,
        delayMs: clampRetryAfterDelay(context.error.retryAfterMs, context.attempt, options),
      };
    case "TRANSFORM_AND_RETRY": {
      if (options.transformRequest === undefined) {
        return null;
      }

      const transformedRequest = await options.transformRequest(context);

      if (transformedRequest === null) {
        return null;
      }

      return {
        request: transformedRequest,
        delayMs: 0,
      };
    }
    case "FALLBACK_MODEL": {
      if (options.selectFallbackModel === undefined) {
        return null;
      }

      const fallbackModel = await options.selectFallbackModel(context);

      if (fallbackModel === null) {
        return null;
      }

      return {
        request: {
          ...context.request,
          model: fallbackModel,
        },
        delayMs: 0,
      };
    }
    default:
      return null;
  }
};

export const sleep = async (delayMs: number): Promise<void> => {
  if (delayMs <= 0) {
    return;
  }

  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
};

const computeBackoffDelayMs = (attempt: number, options: ResolvedModelRetryOptions): number => {
  return Math.min(options.baseDelayMs * 2 ** (attempt - 1), options.maxDelayMs);
};

const clampRetryAfterDelay = (
  retryAfterMs: number | undefined,
  attempt: number,
  options: ResolvedModelRetryOptions,
): number => {
  if (retryAfterMs === undefined) {
    return computeBackoffDelayMs(attempt, options);
  }

  return Math.min(retryAfterMs, options.maxRetryAfterMs);
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

import {
  createNormalizedModelError,
  HttpProviderError,
  type ContextualErrorNormalizer,
  type ModelErrorCode,
  type NormalizedModelError,
  type ProviderResponse,
  type RetryMode,
} from "@renx/model";

export class OpenAIErrorNormalizer implements ContextualErrorNormalizer {
  normalize(error: unknown, model?: string): NormalizedModelError {
    const envelope = unwrapEnvelope(error, model);
    const resolvedError = envelope.error;

    if (resolvedError instanceof HttpProviderError) {
      return normalizeProviderResponse(
        "openai",
        resolvedError.response,
        envelope.model,
        resolvedError,
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
        ...(envelope.model === undefined ? {} : { model: envelope.model }),
      });
    }

    if (resolvedError instanceof Error) {
      const isTimeout =
        resolvedError.name === "TimeoutError" || resolvedError.name === "AbortError";

      return createNormalizedModelError({
        message: resolvedError.message,
        provider: "openai",
        code: isTimeout ? "TIMEOUT" : "UNKNOWN",
        retryable: isTimeout,
        retryMode: isTimeout ? "BACKOFF" : "NONE",
        raw: resolvedError,
        cause: resolvedError,
        ...(envelope.model === undefined ? {} : { model: envelope.model }),
      });
    }

    return createNormalizedModelError({
      message: "Unknown OpenAI provider error",
      provider: "openai",
      code: "UNKNOWN",
      retryable: false,
      retryMode: "NONE",
      raw: resolvedError,
      ...(envelope.model === undefined ? {} : { model: envelope.model }),
    });
  }
}

const unwrapEnvelope = (input: unknown, model?: string): { error: unknown; model?: string } => {
  if (!isRecord(input) || !("error" in input)) {
    return {
      error: input,
      ...(model === undefined ? {} : { model }),
    };
  }

  const resolvedModel = typeof input.model === "string" ? input.model : model;

  return {
    error: input.error,
    ...(resolvedModel === undefined ? {} : { model: resolvedModel }),
  };
};

const normalizeProviderResponse = (
  provider: "openai",
  response: ProviderResponse,
  model?: string,
  cause?: unknown,
): NormalizedModelError => {
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
    ...(model === undefined ? {} : { model }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(payload.code === undefined ? {} : { rawCode: payload.code }),
    ...(payload.type === undefined ? {} : { rawType: payload.type }),
  });
};

const classifyHttpError = (
  httpStatus: number,
  message: string,
  retryAfterMs: number | undefined,
): { code: ModelErrorCode; retryable: boolean; retryMode: RetryMode } => {
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
      retryMode: retryAfterMs === undefined ? "BACKOFF" : "AFTER_DELAY",
    };
  }

  if (httpStatus >= 500) {
    return { code: "SERVER_ERROR", retryable: true, retryMode: "BACKOFF" };
  }

  if (httpStatus === 400 && isContextOverflow(message)) {
    return {
      code: "CONTEXT_OVERFLOW",
      retryable: true,
      retryMode: "TRANSFORM_AND_RETRY",
    };
  }

  return { code: "UNKNOWN", retryable: false, retryMode: "NONE" };
};

const isContextOverflow = (message: string): boolean => {
  const normalized = message.toLowerCase();

  return normalized.includes("context length") || normalized.includes("maximum context length");
};

const parseRetryAfter = (headerValue: string | undefined): number | undefined => {
  if (headerValue === undefined) {
    return undefined;
  }

  const seconds = Number(headerValue);

  return Number.isNaN(seconds) ? undefined : seconds * 1_000;
};

const readErrorPayload = (
  body: unknown,
): { message?: string; code?: string | number; type?: string } => {
  if (!isRecord(body) || !isRecord(body.error)) {
    return {};
  }

  return {
    ...(typeof body.error.message === "string" ? { message: body.error.message } : {}),
    ...(typeof body.error.code === "string" || typeof body.error.code === "number"
      ? { code: body.error.code }
      : {}),
    ...(typeof body.error.type === "string" ? { type: body.error.type } : {}),
  };
};

const isProviderResponse = (value: unknown): value is ProviderResponse => {
  return (
    isRecord(value) &&
    typeof value.status === "number" &&
    isRecord(value.headers) &&
    "body" in value
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

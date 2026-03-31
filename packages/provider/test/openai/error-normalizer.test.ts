import { describe, expect, it } from "vitest";

import { HttpProviderError } from "@renx/model";

import { createErrorNormalizer } from "../../src/shared/error-normalizer";

const httpError = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new HttpProviderError(`HTTP ${status}`, {
    status,
    headers,
    body,
  });

describe("createErrorNormalizer", () => {
  const normalizer = createErrorNormalizer("test-provider");

  it("maps 401 to AUTH_ERROR (not retryable)", () => {
    const result = normalizer.normalize(
      httpError(401, { error: { message: "Invalid API key" } }),
      "gpt-4o",
    );

    expect(result).toMatchObject({
      provider: "test-provider",
      model: "gpt-4o",
      code: "AUTH_ERROR",
      retryable: false,
      retryMode: "NONE",
      httpStatus: 401,
    });
  });

  it("maps 403 to PERMISSION_DENIED (not retryable)", () => {
    const result = normalizer.normalize(
      httpError(403, { error: { message: "Access denied" } }),
      "gpt-4o",
    );

    expect(result).toMatchObject({
      code: "PERMISSION_DENIED",
      retryable: false,
      retryMode: "NONE",
      httpStatus: 403,
    });
  });

  it("maps 429 to RATE_LIMIT with backoff when no retry-after header", () => {
    const result = normalizer.normalize(
      httpError(429, { error: { message: "Slow down" } }),
      "gpt-4o",
    );

    expect(result).toMatchObject({
      code: "RATE_LIMIT",
      retryable: true,
      retryMode: "BACKOFF",
      httpStatus: 429,
    });
  });

  it("maps 429 with retry-after header to RATE_LIMIT with AFTER_DELAY", () => {
    const result = normalizer.normalize(
      httpError(429, { error: { message: "Slow down" } }, { "retry-after": "3" }),
      "gpt-4o",
    );

    expect(result).toMatchObject({
      code: "RATE_LIMIT",
      retryable: true,
      retryMode: "AFTER_DELAY",
      retryAfterMs: 3000,
      httpStatus: 429,
    });
  });

  it("maps 500 to SERVER_ERROR (retryable)", () => {
    const result = normalizer.normalize(
      httpError(500, { error: { message: "Internal server error" } }),
      "gpt-4o",
    );

    expect(result).toMatchObject({
      code: "SERVER_ERROR",
      retryable: true,
      retryMode: "BACKOFF",
      httpStatus: 500,
    });
  });

  it("maps 502 and 503 to SERVER_ERROR (retryable)", () => {
    const r502 = normalizer.normalize(httpError(502, { error: { message: "Bad gateway" } }));
    const r503 = normalizer.normalize(httpError(503, { error: { message: "Unavailable" } }));

    expect(r502).toMatchObject({ code: "SERVER_ERROR", retryable: true });
    expect(r503).toMatchObject({ code: "SERVER_ERROR", retryable: true });
  });

  it("maps 400 with context_length_exceeded to CONTEXT_OVERFLOW", () => {
    const result = normalizer.normalize(
      httpError(400, {
        error: {
          message: "This model's maximum context length is 128000 tokens.",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      }),
      "gpt-4o",
    );

    expect(result).toMatchObject({
      code: "CONTEXT_OVERFLOW",
      retryable: true,
      retryMode: "TRANSFORM_AND_RETRY",
      httpStatus: 400,
      rawCode: "context_length_exceeded",
      rawType: "invalid_request_error",
    });
  });

  it("maps 400 without context overflow to UNKNOWN (not retryable)", () => {
    const result = normalizer.normalize(
      httpError(400, { error: { message: "Invalid request" } }),
      "gpt-4o",
    );

    expect(result).toMatchObject({
      code: "UNKNOWN",
      retryable: false,
      retryMode: "NONE",
      httpStatus: 400,
    });
  });

  it("maps network TypeError to NETWORK_ERROR (retryable)", () => {
    const result = normalizer.normalize(new TypeError("fetch failed"), "gpt-4o");

    expect(result).toMatchObject({
      code: "NETWORK_ERROR",
      retryable: true,
      retryMode: "BACKOFF",
      model: "gpt-4o",
    });
  });

  it("maps TimeoutError to TIMEOUT (retryable)", () => {
    const timeoutError = new Error("Timeout");
    timeoutError.name = "TimeoutError";

    const result = normalizer.normalize(timeoutError, "gpt-4o");

    expect(result).toMatchObject({
      code: "TIMEOUT",
      retryable: true,
      retryMode: "BACKOFF",
    });
  });

  it("maps AbortError to TIMEOUT (retryable)", () => {
    const abortError = new Error("Aborted");
    abortError.name = "AbortError";

    const result = normalizer.normalize(abortError);

    expect(result).toMatchObject({
      code: "TIMEOUT",
      retryable: true,
    });
  });

  it("maps generic Error to UNKNOWN (not retryable)", () => {
    const result = normalizer.normalize(new Error("something broke"), "gpt-4o");

    expect(result).toMatchObject({
      code: "UNKNOWN",
      retryable: false,
      retryMode: "NONE",
      model: "gpt-4o",
    });
  });

  it("maps non-Error values to UNKNOWN", () => {
    const result = normalizer.normalize("string error");

    expect(result).toMatchObject({
      code: "UNKNOWN",
      retryable: false,
      retryMode: "NONE",
    });
  });

  it("unwraps envelope { error, model } structure", () => {
    const result = normalizer.normalize({
      error: new TypeError("network failure"),
      model: "gpt-4o",
    });

    expect(result).toMatchObject({
      code: "NETWORK_ERROR",
      model: "gpt-4o",
    });
  });

  it("extracts rawCode and rawType from error body", () => {
    const result = normalizer.normalize(
      httpError(429, {
        error: {
          message: "Rate limit",
          code: "rate_limit_exceeded",
          type: "rate_limit_error",
        },
      }),
    );

    expect(result).toMatchObject({
      rawCode: "rate_limit_exceeded",
      rawType: "rate_limit_error",
    });
  });
});

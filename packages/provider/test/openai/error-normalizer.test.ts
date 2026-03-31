import { describe, expect, it } from "vitest";

import { HttpProviderError } from "@renx/model";

import { OpenAIErrorNormalizer } from "../../src/openai/index";

describe("OpenAIErrorNormalizer", () => {
  it("maps context overflow responses to transform-and-retry", () => {
    const normalizer = new OpenAIErrorNormalizer();

    const error = normalizer.normalize({
      model: "openai:gpt-4.1",
      error: new HttpProviderError("Request too large", {
        status: 400,
        headers: {},
        body: {
          error: {
            message: "This model's maximum context length is 128000 tokens.",
            type: "invalid_request_error",
            code: "context_length_exceeded",
          },
        },
      }),
    });

    expect(error).toMatchObject({
      provider: "openai",
      model: "openai:gpt-4.1",
      code: "CONTEXT_OVERFLOW",
      retryable: true,
      retryMode: "TRANSFORM_AND_RETRY",
      httpStatus: 400,
    });
  });
});

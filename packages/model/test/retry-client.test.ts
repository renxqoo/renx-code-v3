import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelError } from "../src/errors";
import { createModelClient } from "../src/client";
import type { ModelAdapter } from "../src/adapter";
import type { ModelRequest } from "../src/types";

describe("createModelClient retry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries retryable failures with exponential backoff by default", async () => {
    vi.useFakeTimers();

    const calls: string[] = [];
    const adapter: ModelAdapter = {
      name: "openai",
      async generate(request: ModelRequest) {
        calls.push(request.model);

        if (calls.length < 3) {
          throw new ModelError({
            message: "Service unavailable",
            provider: "openai",
            model: request.model,
            code: "SERVER_ERROR",
            retryable: true,
            retryMode: "BACKOFF",
            raw: null,
          });
        }

        return {
          type: "final",
          output: "ok",
        };
      },
    };

    const client = createModelClient({
      providers: [
        {
          name: "openai",
          adapter,
        },
      ],
      resolveModel(model) {
        if (model !== "gpt-5.4") {
          throw new Error(`Model not found: ${model}`);
        }

        return {
          id: "gpt-5.4",
          provider: "openai",
          providerModel: "gpt-5.4",
        };
      },
    });

    const resultPromise = client.generate({
      model: "gpt-5.4",
      systemPrompt: "",
      messages: [],
      tools: [],
    });

    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(600);

    await expect(resultPromise).resolves.toEqual({
      type: "final",
      output: "ok",
    });
    expect(calls).toEqual(["gpt-5.4", "gpt-5.4", "gpt-5.4"]);
  });

  it("honors retry-after delays when the provider supplies them", async () => {
    vi.useFakeTimers();

    let attempts = 0;
    const adapter: ModelAdapter = {
      name: "openai",
      async describeRequest() {
        return {
          endpoint: "https://api.openai.com/v1/chat/completions",
          method: "POST",
        };
      },
      async generate() {
        attempts += 1;

        if (attempts === 1) {
          throw new ModelError({
            message: "Too many requests",
            provider: "openai",
            model: "gpt-5.4",
            code: "RATE_LIMIT",
            retryable: true,
            retryMode: "AFTER_DELAY",
            retryAfterMs: 1_000,
            raw: null,
          });
        }

        return {
          type: "final",
          output: "ok",
        };
      },
    };

    const observer = vi.fn();
    const client = createModelClient({
      providers: [
        {
          name: "openai",
          adapter,
        },
      ],
      resolveModel(model) {
        if (model !== "gpt-5.4") {
          throw new Error(`Model not found: ${model}`);
        }

        return {
          id: "gpt-5.4",
          provider: "openai",
          providerModel: "gpt-5.4",
        };
      },
    });

    const resultPromise = client.generate({
      model: "gpt-5.4",
      systemPrompt: "",
      messages: [],
      tools: [],
      observer,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toEqual({
      type: "final",
      output: "ok",
    });
    expect(observer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        status: "attempting",
        attempt: 1,
        maxAttempts: 3,
        logicalModel: "gpt-5.4",
        provider: "openai",
        providerModel: "gpt-5.4",
        request: expect.objectContaining({
          endpoint: "https://api.openai.com/v1/chat/completions",
          method: "POST",
          messageCount: 0,
          toolCount: 0,
          hasSystemPrompt: false,
        }),
      }),
    );
    expect(observer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        status: "retrying",
        attempt: 1,
        delayMs: 1_000,
        error: expect.objectContaining({
          code: "RATE_LIMIT",
          message: "Too many requests",
          retryMode: "AFTER_DELAY",
          retryAfterMs: 1_000,
        }),
      }),
    );
    expect(observer).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        status: "attempting",
        attempt: 2,
      }),
    );
    expect(observer).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        status: "success",
        attempt: 2,
        responseType: "final",
      }),
    );
  });

  it("can transform the request before retrying context overflow failures", async () => {
    const seenMessageCounts: number[] = [];
    const adapter: ModelAdapter = {
      name: "glm",
      async generate(request: ModelRequest) {
        seenMessageCounts.push(request.messages.length);

        if (seenMessageCounts.length === 1) {
          throw new ModelError({
            message: "maximum context length exceeded",
            provider: "glm",
            model: request.model,
            code: "CONTEXT_OVERFLOW",
            retryable: true,
            retryMode: "TRANSFORM_AND_RETRY",
            raw: null,
          });
        }

        return {
          type: "final",
          output: "ok",
        };
      },
    };

    const client = createModelClient({
      providers: [
        {
          name: "glm",
          adapter,
        },
      ],
      resolveModel(model) {
        if (model !== "glm-5.1") {
          throw new Error(`Model not found: ${model}`);
        }

        return {
          id: "glm-5.1",
          provider: "glm",
          providerModel: "GLM-5.1",
        };
      },
      retry: {
        transformRequest(context) {
          return {
            ...context.request,
            messages: context.request.messages.slice(-1),
          };
        },
      },
    });

    await expect(
      client.generate({
        model: "glm-5.1",
        systemPrompt: "",
        messages: [
          {
            id: "m1",
            role: "user",
            content: "first",
            createdAt: "2026-03-31T00:00:00.000Z",
          },
          {
            id: "m2",
            role: "user",
            content: "second",
            createdAt: "2026-03-31T00:00:01.000Z",
          },
        ],
        tools: [],
      }),
    ).resolves.toEqual({
      type: "final",
      output: "ok",
    });

    expect(seenMessageCounts).toEqual([2, 1]);
  });

  it("can disable automatic retry completely", async () => {
    let attempts = 0;
    const adapter: ModelAdapter = {
      name: "openai",
      async generate(request: ModelRequest) {
        attempts += 1;

        throw new ModelError({
          message: "Service unavailable",
          provider: "openai",
          model: request.model,
          code: "SERVER_ERROR",
          retryable: true,
          retryMode: "BACKOFF",
          raw: null,
        });
      },
    };

    const client = createModelClient({
      providers: [
        {
          name: "openai",
          adapter,
        },
      ],
      resolveModel(model) {
        if (model !== "gpt-5.4") {
          throw new Error(`Model not found: ${model}`);
        }

        return {
          id: "gpt-5.4",
          provider: "openai",
          providerModel: "gpt-5.4",
        };
      },
      retry: false,
    });

    await expect(
      client.generate({
        model: "gpt-5.4",
        systemPrompt: "",
        messages: [],
        tools: [],
      }),
    ).rejects.toMatchObject({
      code: "SERVER_ERROR",
    });
    expect(attempts).toBe(1);
  });
});

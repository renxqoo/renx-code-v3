import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelError } from "../src/errors";
import { createModelClient } from "../src/client";
import type { ModelAdapter, ModelStreamEvent, ModelRequest } from "../src/index";

describe("createModelClient stream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("yields streaming events from the adapter", async () => {
    const adapter: ModelAdapter = {
      name: "openai",
      async generate() {
        return { type: "final", output: "" };
      },
      async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
        yield { type: "text_delta", text: "Hello" };
        yield { type: "text_delta", text: " world" };
        yield { type: "done" };
      },
    };

    const client = createModelClient({
      providers: [{ name: "openai", adapter }],
      resolveModel: (model) => ({ id: model, provider: "openai", providerModel: model }),
    });

    const events: ModelStreamEvent[] = [];

    for await (const event of client.stream({
      model: "gpt-4o",
      systemPrompt: "",
      messages: [],
      tools: [],
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
      { type: "done" },
    ]);
  });

  it("throws when adapter does not support streaming", async () => {
    const adapter: ModelAdapter = {
      name: "openai",
      async generate() {
        return { type: "final", output: "" };
      },
    };

    const client = createModelClient({
      providers: [{ name: "openai", adapter }],
      resolveModel: (model) => ({ id: model, provider: "openai", providerModel: model }),
    });

    const iterator = client.stream({
      model: "gpt-4o",
      systemPrompt: "",
      messages: [],
      tools: [],
    });

    await expect(iterator[Symbol.asyncIterator]().next()).rejects.toThrow(
      "Streaming not supported for model: gpt-4o",
    );
  });

  it("retries connection-phase failures before first event is yielded", async () => {
    vi.useFakeTimers();

    let attempts = 0;
    const adapter: ModelAdapter = {
      name: "openai",
      async generate() {
        return { type: "final", output: "" };
      },
      async *stream(): AsyncIterable<ModelStreamEvent> {
        attempts += 1;

        if (attempts < 3) {
          throw new ModelError({
            message: "Service unavailable",
            provider: "openai",
            code: "SERVER_ERROR",
            retryable: true,
            retryMode: "BACKOFF",
            raw: null,
          });
        }

        yield { type: "text_delta", text: "recovered" };
        yield { type: "done" };
      },
    };

    const client = createModelClient({
      providers: [{ name: "openai", adapter }],
      resolveModel: (model) => ({ id: model, provider: "openai", providerModel: model }),
    });

    const resultPromise = (async () => {
      const events: ModelStreamEvent[] = [];

      for await (const event of client.stream({
        model: "gpt-4o",
        systemPrompt: "",
        messages: [],
        tools: [],
      })) {
        events.push(event);
      }

      return events;
    })();

    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(600);

    const events = await resultPromise;

    expect(attempts).toBe(3);
    expect(events).toEqual([{ type: "text_delta", text: "recovered" }, { type: "done" }]);
  });

  it("does not retry after first event is yielded (mid-stream error)", async () => {
    let attempts = 0;
    const adapter: ModelAdapter = {
      name: "openai",
      async generate() {
        return { type: "final", output: "" };
      },
      async *stream(): AsyncIterable<ModelStreamEvent> {
        attempts += 1;
        yield { type: "text_delta", text: "first" };
        throw new ModelError({
          message: "Connection lost",
          provider: "openai",
          code: "SERVER_ERROR",
          retryable: true,
          retryMode: "BACKOFF",
          raw: null,
        });
      },
    };

    const client = createModelClient({
      providers: [{ name: "openai", adapter }],
      resolveModel: (model) => ({ id: model, provider: "openai", providerModel: model }),
    });

    const events: ModelStreamEvent[] = [];

    await expect(
      (async () => {
        for await (const event of client.stream({
          model: "gpt-4o",
          systemPrompt: "",
          messages: [],
          tools: [],
        })) {
          events.push(event);
        }
      })(),
    ).rejects.toMatchObject({
      code: "SERVER_ERROR",
      message: "Connection lost",
    });

    expect(attempts).toBe(1);
    expect(events).toEqual([{ type: "text_delta", text: "first" }]);
  });

  it("does not retry streaming when retry is disabled", async () => {
    let attempts = 0;
    const adapter: ModelAdapter = {
      name: "openai",
      async generate() {
        return { type: "final", output: "" };
      },
      stream(): AsyncIterable<ModelStreamEvent> {
        attempts += 1;

        throw new ModelError({
          message: "Service unavailable",
          provider: "openai",
          code: "SERVER_ERROR",
          retryable: true,
          retryMode: "BACKOFF",
          raw: null,
        });
      },
    };

    const client = createModelClient({
      providers: [{ name: "openai", adapter }],
      resolveModel: (model) => ({ id: model, provider: "openai", providerModel: model }),
      retry: false,
    });

    await expect(
      client
        .stream({ model: "gpt-4o", systemPrompt: "", messages: [], tools: [] })
        [Symbol.asyncIterator]()
        .next(),
    ).rejects.toMatchObject({ code: "SERVER_ERROR" });

    expect(attempts).toBe(1);
  });

  it("throws non-normalized errors immediately without retry", async () => {
    let attempts = 0;
    const adapter: ModelAdapter = {
      name: "openai",
      async generate() {
        return { type: "final", output: "" };
      },
      stream(): AsyncIterable<ModelStreamEvent> {
        attempts += 1;
        throw new Error("raw non-normalized error");
      },
    };

    const client = createModelClient({
      providers: [{ name: "openai", adapter }],
      resolveModel: (model) => ({ id: model, provider: "openai", providerModel: model }),
    });

    await expect(
      client
        .stream({ model: "gpt-4o", systemPrompt: "", messages: [], tools: [] })
        [Symbol.asyncIterator]()
        .next(),
    ).rejects.toThrow("raw non-normalized error");

    expect(attempts).toBe(1);
  });
});

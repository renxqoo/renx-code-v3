import { describe, expect, it } from "vitest";

import {
  HttpProviderError,
  type ModelRequest,
  type ModelStreamEvent,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderStreamChunk,
} from "@renx/model";

import { OpenAICompatAdapter } from "../../src/shared/adapter";

class RecordingProvider implements Provider {
  name = "recording";
  lastRequest?: ProviderRequest;

  constructor(private readonly response: ProviderResponse) {}

  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    this.lastRequest = request;

    return this.response;
  }
}

class RejectingProvider implements Provider {
  name = "rejecting";

  async execute(): Promise<ProviderResponse> {
    throw new HttpProviderError("Too many requests", {
      status: 429,
      headers: {
        "retry-after": "1",
      },
      body: {
        error: {
          message: "Too many requests",
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
        },
      },
    });
  }
}

class StreamingProvider implements Provider {
  name = "streaming";
  lastRequest?: ProviderRequest;

  constructor(private readonly chunks: string[]) {}

  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    this.lastRequest = request;

    return { status: 200, headers: {}, body: {} };
  }

  async *executeStream(request: ProviderRequest): AsyncIterable<ProviderStreamChunk> {
    this.lastRequest = request;

    for (const chunk of this.chunks) {
      yield { raw: chunk };
    }
  }
}

const request: ModelRequest = {
  model: "openai:gpt-4.1",
  systemPrompt: "You are helpful.",
  messages: [
    {
      id: "msg_1",
      role: "user",
      content: "hello",
      createdAt: "2026-03-31T00:00:00.000Z",
    },
  ],
  tools: [
    {
      name: "lookup_order",
      description: "Lookup an order by id",
      inputSchema: {
        type: "object",
      },
    },
  ],
  temperature: 0.2,
  maxTokens: 200,
};

describe("OpenAICompatAdapter (openai)", () => {
  it("renders requests and normalizes final responses", async () => {
    const provider = new RecordingProvider({
      status: 200,
      headers: {},
      body: {
        choices: [
          {
            message: {
              content: "hello back",
            },
          },
        ],
      },
    });
    const adapter = new OpenAICompatAdapter(provider, {
      name: "openai",
      endpoint: "https://api.openai.com/v1/chat/completions",
    });

    await expect(adapter.generate(request)).resolves.toEqual({
      type: "final",
      output: "hello back",
    });
    expect(provider.lastRequest).toMatchObject({
      url: "https://api.openai.com/v1/chat/completions",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        model: "gpt-4.1",
        temperature: 0.2,
        max_tokens: 200,
      },
    });
    expect(provider.lastRequest?.body).toMatchObject({
      messages: [
        {
          role: "system",
          content: "You are helpful.",
        },
        {
          role: "user",
          content: "hello",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup_order",
            description: "Lookup an order by id",
            parameters: {
              type: "object",
            },
          },
        },
      ],
    });
  });

  it("normalizes tool call responses", async () => {
    const provider = new RecordingProvider({
      status: 200,
      headers: {},
      body: {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "lookup_order",
                    arguments: '{"orderId":"123"}',
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const adapter = new OpenAICompatAdapter(provider, {
      name: "openai",
      endpoint: "https://api.openai.com/v1/chat/completions",
    });

    await expect(adapter.generate(request)).resolves.toEqual({
      type: "tool_calls",
      toolCalls: [
        {
          id: "call_1",
          name: "lookup_order",
          input: {
            orderId: "123",
          },
        },
      ],
    });
  });

  it("normalizes provider errors into shared model errors", async () => {
    const adapter = new OpenAICompatAdapter(new RejectingProvider(), {
      name: "openai",
      endpoint: "https://api.openai.com/v1/chat/completions",
    });

    await expect(adapter.generate(request)).rejects.toMatchObject({
      name: "ModelError",
      provider: "openai",
      model: "openai:gpt-4.1",
      code: "RATE_LIMIT",
      retryable: true,
      retryMode: "AFTER_DELAY",
      retryAfterMs: 1_000,
    });
  });

  it("passes signal through to provider request", async () => {
    const controller = new AbortController();
    const provider = new RecordingProvider({
      status: 200,
      headers: {},
      body: { choices: [{ message: { content: "ok" } }] },
    });
    const adapter = new OpenAICompatAdapter(provider, {
      name: "openai",
      endpoint: "https://api.openai.com/v1/chat/completions",
    });

    await adapter.generate({ ...request, signal: controller.signal });

    expect(provider.lastRequest?.signal).toBe(controller.signal);
  });

  // ── streaming ──

  it("streams text delta events", async () => {
    const provider = new StreamingProvider([
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    const adapter = new OpenAICompatAdapter(provider, {
      name: "openai",
      endpoint: "https://api.openai.com/v1/chat/completions",
    });

    const events: ModelStreamEvent[] = [];

    for await (const event of adapter.stream(request)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", text: "Hi" },
      { type: "text_delta", text: " there" },
      { type: "done" },
    ]);
  });

  it("streams tool call events with argument accumulation", async () => {
    const provider = new StreamingProvider([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"SF\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    const adapter = new OpenAICompatAdapter(provider, {
      name: "openai",
      endpoint: "https://api.openai.com/v1/chat/completions",
    });

    const events: ModelStreamEvent[] = [];

    for await (const event of adapter.stream(request)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "tool_call_delta", partial: expect.objectContaining({ index: 0, id: "call_1" }) },
      { type: "tool_call_delta", partial: expect.objectContaining({ index: 0 }) },
      { type: "tool_call_delta", partial: expect.objectContaining({ index: 0 }) },
      {
        type: "tool_call",
        call: {
          id: "call_1",
          name: "get_weather",
          input: { city: "SF" },
        },
      },
      { type: "done" },
    ]);
  });

  it("handles tool calls with malformed arguments gracefully", async () => {
    const provider = new StreamingProvider([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_2","type":"function","function":{"name":"search","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{invalid"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    const adapter = new OpenAICompatAdapter(provider, {
      name: "openai",
      endpoint: "https://api.openai.com/v1/chat/completions",
    });

    const events: ModelStreamEvent[] = [];

    for await (const event of adapter.stream(request)) {
      events.push(event);
    }

    const toolCallEvent = events.find((e) => e.type === "tool_call");

    expect(toolCallEvent).toEqual({
      type: "tool_call",
      call: {
        id: "call_2",
        name: "search",
        input: { raw: "{invalid" },
      },
    });
  });

  it("sends stream: true in the request body", async () => {
    const provider = new StreamingProvider(["data: [DONE]\n\n"]);
    const adapter = new OpenAICompatAdapter(provider, {
      name: "openai",
      endpoint: "https://api.openai.com/v1/chat/completions",
    });

    const events: ModelStreamEvent[] = [];

    for await (const event of adapter.stream(request)) {
      events.push(event);
    }

    expect(provider.lastRequest?.body).toMatchObject({
      stream: true,
    });
  });

  it("throws when provider does not support streaming", async () => {
    const provider = new RecordingProvider({ status: 200, headers: {}, body: {} });
    const adapter = new OpenAICompatAdapter(provider, {
      name: "openai",
      endpoint: "https://api.openai.com/v1/chat/completions",
    });

    await expect(adapter.stream(request)[Symbol.asyncIterator]().next()).rejects.toThrow(
      'Provider "openai" does not support streaming',
    );
  });

  it("streams mixed text and tool call content", async () => {
    const provider = new StreamingProvider([
      'data: {"choices":[{"delta":{"content":"Let me check"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_3","type":"function","function":{"name":"lookup","arguments":"{\\"q\\"" }}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"test\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    const adapter = new OpenAICompatAdapter(provider, {
      name: "openai",
      endpoint: "https://api.openai.com/v1/chat/completions",
    });

    const events: ModelStreamEvent[] = [];

    for await (const event of adapter.stream(request)) {
      events.push(event);
    }

    const textEvents = events.filter((e) => e.type === "text_delta");
    const toolCallEvents = events.filter((e) => e.type === "tool_call");
    const doneEvents = events.filter((e) => e.type === "done");

    expect(textEvents).toEqual([{ type: "text_delta", text: "Let me check" }]);
    expect(toolCallEvents).toEqual([
      { type: "tool_call", call: { id: "call_3", name: "lookup", input: { q: "test" } } },
    ]);
    expect(doneEvents).toEqual([{ type: "done" }]);
  });
});

import { describe, expect, it } from "vitest";

import {
  HttpProviderError,
  type ModelRequest,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
} from "@renx/model";

import { OpenAIModelAdapter } from "../../src/openai/index";

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

describe("OpenAIModelAdapter", () => {
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
    const adapter = new OpenAIModelAdapter(provider);

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
    const adapter = new OpenAIModelAdapter(provider);

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
    const adapter = new OpenAIModelAdapter(new RejectingProvider());

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
});

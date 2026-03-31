import { describe, expect, it } from "vitest";

import {
  HttpProviderError,
  type ModelRequest,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
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
        "retry-after": "3",
      },
      body: {
        error: {
          message: "Rate limit exceeded",
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
        },
      },
    });
  }
}

const request: ModelRequest = {
  model: "kimi:moonshot-v1-128k",
  systemPrompt: "You are helpful.",
  messages: [
    {
      id: "msg_1",
      role: "user",
      content: "你好",
      createdAt: "2026-04-01T00:00:00.000Z",
    },
  ],
  tools: [],
};

describe("OpenAICompatAdapter (kimi)", () => {
  it("renders requests and normalizes final responses", async () => {
    const provider = new RecordingProvider({
      status: 200,
      headers: {},
      body: {
        choices: [
          {
            message: {
              content: "你好！有什么可以帮你的？",
            },
          },
        ],
      },
    });
    const adapter = new OpenAICompatAdapter(provider, {
      name: "kimi",
      endpoint: "https://api.moonshot.cn/v1/chat/completions",
    });

    await expect(adapter.generate(request)).resolves.toEqual({
      type: "final",
      output: "你好！有什么可以帮你的？",
    });
    expect(provider.lastRequest).toMatchObject({
      url: "https://api.moonshot.cn/v1/chat/completions",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        model: "moonshot-v1-128k",
      },
    });
  });

  it("normalizes kimi provider errors", async () => {
    const adapter = new OpenAICompatAdapter(new RejectingProvider(), {
      name: "kimi",
      endpoint: "https://api.moonshot.cn/v1/chat/completions",
    });

    await expect(adapter.generate(request)).rejects.toMatchObject({
      name: "ModelError",
      provider: "kimi",
      model: "kimi:moonshot-v1-128k",
      code: "RATE_LIMIT",
      retryable: true,
      retryMode: "AFTER_DELAY",
      retryAfterMs: 3_000,
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
                  id: "call_k1",
                  type: "function",
                  function: {
                    name: "search",
                    arguments: '{"query":"天气"}',
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const adapter = new OpenAICompatAdapter(provider, {
      name: "kimi",
      endpoint: "https://api.moonshot.cn/v1/chat/completions",
    });

    await expect(
      adapter.generate({
        ...request,
        tools: [
          {
            name: "search",
            description: "搜索",
            inputSchema: { type: "object", properties: { query: { type: "string" } } },
          },
        ],
      }),
    ).resolves.toEqual({
      type: "tool_calls",
      toolCalls: [
        {
          id: "call_k1",
          name: "search",
          input: { query: "天气" },
        },
      ],
    });
  });
});

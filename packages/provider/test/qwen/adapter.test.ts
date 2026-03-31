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
      headers: { "retry-after": "2" },
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
  model: "qwen:qwen-plus",
  systemPrompt: "You are helpful.",
  messages: [{ id: "msg_1", role: "user", content: "你好", createdAt: "2026-04-01T00:00:00.000Z" }],
  tools: [],
};

describe("OpenAICompatAdapter (qwen)", () => {
  it("renders requests and normalizes final responses", async () => {
    const provider = new RecordingProvider({
      status: 200,
      headers: {},
      body: { choices: [{ message: { content: "你好！有什么可以帮你？" } }] },
    });
    const adapter = new OpenAICompatAdapter(provider, {
      name: "qwen",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    });

    await expect(adapter.generate(request)).resolves.toEqual({
      type: "final",
      output: "你好！有什么可以帮你？",
    });
    expect(provider.lastRequest).toMatchObject({
      url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      body: { model: "qwen-plus" },
    });
  });

  it("normalizes qwen provider errors", async () => {
    const adapter = new OpenAICompatAdapter(new RejectingProvider(), {
      name: "qwen",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    });

    await expect(adapter.generate(request)).rejects.toMatchObject({
      name: "ModelError",
      provider: "qwen",
      model: "qwen:qwen-plus",
      code: "RATE_LIMIT",
      retryable: true,
      retryMode: "AFTER_DELAY",
      retryAfterMs: 2_000,
    });
  });
});

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
    throw new HttpProviderError("Internal error", {
      status: 500,
      headers: {},
      body: {
        error: {
          message: "Internal server error",
          type: "internal_error",
        },
      },
    });
  }
}

const request: ModelRequest = {
  model: "minimax:minimax-m1",
  systemPrompt: "You are helpful.",
  messages: [{ id: "msg_1", role: "user", content: "你好", createdAt: "2026-04-01T00:00:00.000Z" }],
  tools: [],
};

describe("OpenAICompatAdapter (minimax)", () => {
  it("renders requests and normalizes final responses", async () => {
    const provider = new RecordingProvider({
      status: 200,
      headers: {},
      body: { choices: [{ message: { content: "你好！" } }] },
    });
    const adapter = new OpenAICompatAdapter(provider, {
      name: "minimax",
      endpoint: "https://api.minimax.io/v1/chat/completions",
    });

    await expect(adapter.generate(request)).resolves.toEqual({
      type: "final",
      output: "你好！",
    });
    expect(provider.lastRequest).toMatchObject({
      url: "https://api.minimax.io/v1/chat/completions",
      body: { model: "minimax-m1" },
    });
  });

  it("normalizes minimax provider errors", async () => {
    const adapter = new OpenAICompatAdapter(new RejectingProvider(), {
      name: "minimax",
      endpoint: "https://api.minimax.io/v1/chat/completions",
    });

    await expect(adapter.generate(request)).rejects.toMatchObject({
      name: "ModelError",
      provider: "minimax",
      model: "minimax:minimax-m1",
      code: "SERVER_ERROR",
      retryable: true,
      retryMode: "BACKOFF",
      httpStatus: 500,
    });
  });
});

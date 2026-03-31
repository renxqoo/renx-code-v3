import { describe, expect, it } from "vitest";

import {
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

const request: ModelRequest = {
  model: "openrouter:anthropic/claude-sonnet-4-20250514",
  systemPrompt: "",
  messages: [{ id: "msg_1", role: "user", content: "Hi", createdAt: "2026-04-01T00:00:00.000Z" }],
  tools: [],
};

describe("OpenAICompatAdapter (openrouter)", () => {
  it("renders requests with provider-prefixed model names", async () => {
    const provider = new RecordingProvider({
      status: 200,
      headers: {},
      body: { choices: [{ message: { content: "Hello!" } }] },
    });
    const adapter = new OpenAICompatAdapter(provider, {
      name: "openrouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
    });

    await expect(adapter.generate(request)).resolves.toEqual({
      type: "final",
      output: "Hello!",
    });
    expect(provider.lastRequest).toMatchObject({
      url: "https://openrouter.ai/api/v1/chat/completions",
      body: {
        model: "anthropic/claude-sonnet-4-20250514",
      },
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  HttpProviderError,
  type ModelRequest,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
} from "@renx/model";

import { GlmModelAdapter } from "../../src/glm";

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
        "retry-after": "2",
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
  model: "glm:GLM-5.1",
  systemPrompt: "You are a coding planner.",
  messages: [
    {
      id: "msg_1",
      role: "user",
      content: "拆一下重构计划",
      createdAt: "2026-03-31T00:00:00.000Z",
    },
  ],
  tools: [],
};

describe("GlmModelAdapter", () => {
  it("renders requests to the coding plan endpoint and normalizes final responses", async () => {
    const provider = new RecordingProvider({
      status: 200,
      headers: {},
      body: {
        choices: [
          {
            message: {
              content: "step 1",
            },
          },
        ],
      },
    });
    const adapter = new GlmModelAdapter(provider);

    await expect(adapter.generate(request)).resolves.toEqual({
      type: "final",
      output: "step 1",
    });
    expect(provider.lastRequest).toMatchObject({
      url: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
      body: {
        model: "GLM-5.1",
      },
    });
  });

  it("normalizes glm provider errors", async () => {
    const adapter = new GlmModelAdapter(new RejectingProvider());

    await expect(adapter.generate(request)).rejects.toMatchObject({
      name: "ModelError",
      provider: "glm",
      model: "glm:GLM-5.1",
      code: "RATE_LIMIT",
      retryable: true,
      retryMode: "AFTER_DELAY",
      retryAfterMs: 2_000,
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  BaseModelAdapter,
  ModelError,
  type ModelRequest,
  type ModelStreamEvent,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
  type StreamingProvider,
  type ProviderStreamChunk,
} from "../src/index";

class RecordingProvider implements Provider {
  name = "recording";
  lastRequest?: ProviderRequest;

  constructor(private readonly response: ProviderResponse) {}

  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    this.lastRequest = request;

    return this.response;
  }
}

class ThrowingProvider implements Provider {
  name = "throwing";

  async execute(): Promise<ProviderResponse> {
    throw new Error("boom");
  }
}

class TestAdapter extends BaseModelAdapter {
  name = "test";

  protected toProviderRequest(request: ModelRequest): ProviderRequest {
    return {
      url: "https://example.test/models",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        model: request.model,
      },
    };
  }

  protected fromProviderResponse(response: ProviderResponse) {
    return {
      type: "final" as const,
      output: String(response.body),
    };
  }

  protected normalizeError(error: unknown, request: ModelRequest) {
    return new ModelError({
      message: error instanceof Error ? error.message : "unknown",
      provider: this.name,
      model: request.model,
      code: "UNKNOWN",
      retryable: false,
      retryMode: "NONE",
      raw: error,
    });
  }
}

const request: ModelRequest = {
  model: "test:model",
  systemPrompt: "",
  messages: [],
  tools: [],
};

describe("BaseModelAdapter", () => {
  it("translates a model request through the provider", async () => {
    const provider = new RecordingProvider({
      status: 200,
      headers: {},
      body: "ok",
    });
    const adapter = new TestAdapter(provider);

    await expect(adapter.generate(request)).resolves.toEqual({
      type: "final",
      output: "ok",
    });
    expect(provider.lastRequest).toEqual({
      url: "https://example.test/models",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        model: "test:model",
      },
    });
  });

  it("normalizes provider errors before surfacing them", async () => {
    const adapter = new TestAdapter(new ThrowingProvider());

    await expect(adapter.generate(request)).rejects.toMatchObject({
      name: "ModelError",
      provider: "test",
      model: "test:model",
      message: "boom",
    });
  });

  it("normalizes stream errors via withErrorNormalization", async () => {
    class ThrowingStreamProvider implements StreamingProvider {
      name = "throwing-stream";

      async execute(): Promise<ProviderResponse> {
        return { status: 200, headers: {}, body: {} };
      }

      async *executeStream(): AsyncIterable<ProviderStreamChunk> {
        yield { raw: "first" };
        throw new Error("stream boom");
      }
    }

    class StreamAdapter extends TestAdapter {
      async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
        yield* this.withErrorNormalization(_request, this.doStream());
      }

      private async *doStream(): AsyncIterable<ModelStreamEvent> {
        yield { type: "text_delta", text: "hello" };
        throw new Error("stream boom");
      }
    }

    const adapter = new StreamAdapter(new ThrowingStreamProvider());
    const events: ModelStreamEvent[] = [];

    await expect(
      (async () => {
        for await (const event of adapter.stream(request)) {
          events.push(event);
        }
      })(),
    ).rejects.toMatchObject({
      name: "ModelError",
      provider: "test",
      model: "test:model",
      message: "stream boom",
    });

    expect(events).toEqual([{ type: "text_delta", text: "hello" }]);
  });
});

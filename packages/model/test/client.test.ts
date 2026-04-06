import { describe, expect, it } from "vitest";

import type { ModelAdapter } from "../src/adapter";
import { createModelBinding, createModelClient } from "../src/client";

describe("createModelClient", () => {
  it("lets callers generate with a logical model name directly", async () => {
    const calls: unknown[] = [];
    const adapter: ModelAdapter = {
      name: "openai",
      async generate(request) {
        calls.push(request);

        return {
          type: "final",
          output: `provider:${request.model}`,
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

    await expect(
      client.generate({
        model: "gpt-5.4",
        systemPrompt: "You are helpful.",
        messages: [],
        tools: [],
      }),
    ).resolves.toEqual({
      type: "final",
      output: "provider:gpt-5.4",
    });

    expect(calls).toEqual([
      {
        model: "gpt-5.4",
        systemPrompt: "You are helpful.",
        messages: [],
        tools: [],
        metadata: {
          logicalModel: "gpt-5.4",
          provider: "openai",
          providerModel: "gpt-5.4",
        },
      },
    ]);
  });

  it("resolves a logical model without exposing internal registries", () => {
    const adapter: ModelAdapter = {
      name: "zhipu",
      async generate() {
        return {
          type: "final",
          output: "ok",
        };
      },
    };

    const client = createModelClient({
      providers: [
        {
          name: "zhipu",
          adapter,
        },
      ],
      resolveModel(model) {
        if (model !== "glm-5") {
          throw new Error(`Model not found: ${model}`);
        }

        return {
          provider: "zhipu",
          providerModel: "glm-5",
          id: "glm-5",
        };
      },
    });

    expect(client.resolve("glm-5")).toEqual({
      logicalModel: "glm-5",
      provider: "zhipu",
      providerModel: "glm-5",
    });
  });

  it("creates a model binding for higher-level agent assembly", () => {
    const adapter: ModelAdapter = {
      name: "openai",
      async generate() {
        return {
          type: "final",
          output: "ok",
        };
      },
    };
    const client = createModelClient({
      providers: [{ name: "openai", adapter }],
      resolveModel(model) {
        return {
          id: model,
          provider: "openai",
          providerModel: model,
        };
      },
    });

    expect(createModelBinding(client, "gpt-5.4")).toEqual({
      client,
      name: "gpt-5.4",
    });
  });
});

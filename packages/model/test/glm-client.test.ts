import { describe, expect, it } from "vitest";

import { createModelClient } from "../src/client";
import type { ModelAdapter } from "../src/adapter";
import type { ModelProvider } from "../src/client";
import type { ModelRequest } from "../src/types";

describe("createModelClient with glm", () => {
  it("routes glm-5.1 logical model names to the glm provider model", async () => {
    const calls: unknown[] = [];
    const glmProvider: ModelProvider = {
      name: "glm",
      adapter: {
        name: "glm",
        async generate(request: ModelRequest) {
          calls.push(request);

          return {
            type: "final",
            output: "ok",
          };
        },
      } satisfies ModelAdapter,
    };

    const client = createModelClient({
      providers: [glmProvider],
      resolveModel(model) {
        if (model !== "glm-5.1") {
          throw new Error(`Model not found: ${model}`);
        }

        return {
          id: "glm-5.1",
          provider: "glm",
          providerModel: "GLM-5.1",
        };
      },
    });

    await expect(
      client.generate({
        model: "glm-5.1",
        systemPrompt: "You are a coding planner.",
        messages: [],
        tools: [],
      }),
    ).resolves.toEqual({
      type: "final",
      output: "ok",
    });

    expect(calls).toEqual([
      {
        model: "GLM-5.1",
        systemPrompt: "You are a coding planner.",
        messages: [],
        tools: [],
        metadata: {
          logicalModel: "glm-5.1",
          provider: "glm",
          providerModel: "GLM-5.1",
        },
      },
    ]);
  });
});

import { afterEach, describe, expect, it } from "vitest";

import { createModelClient } from "../src/client";

describe("@renx/provider createModelClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("creates a direct-use client for openai models", async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = async (_input: unknown, init?: RequestInit): Promise<Response> => {
      requests.push(init ?? {});

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "ok",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    };

    globalThis.fetch = fetchImpl as typeof fetch;
    const client = createModelClient({
      openai: {
        apiKey: "test-key",
        endpoint: "https://api.openai.com/v1/chat/completions",
      },
    });

    await expect(
      client.generate({
        model: "gpt-5.4",
        systemPrompt: "",
        messages: [],
        tools: [],
      }),
    ).resolves.toEqual({
      type: "final",
      output: "ok",
    });

    expect(requests).toHaveLength(1);
  });

  it("infers glm provider and normalizes glm model names", async () => {
    const requests: RequestInit[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
      requests.push(init ?? {});

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "glm ok",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    }) as typeof fetch;

    const client = createModelClient({
      glm: {
        apiKey: "glm-key",
      },
    });

    await expect(
      client.generate({
        model: "glm-5.1",
        systemPrompt: "",
        messages: [],
        tools: [],
      }),
    ).resolves.toEqual({
      type: "final",
      output: "glm ok",
    });

    expect(requests).toHaveLength(1);
    const body = JSON.parse(String(requests[0]?.body ?? "{}")) as Record<string, unknown>;
    expect(body.model).toBe("GLM-5.1");
  });
});

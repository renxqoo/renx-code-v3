import { afterEach, describe, expect, it } from "vitest";

import { createModelClient, createProviderModelBinding } from "../src/client";
import { createGlmProvider } from "../src/glm";
import { createKimiProvider } from "../src/kimi";
import { createOpenAIProvider } from "../src/openai";

describe("@renx/provider createModelClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("creates a client with openai provider and infers model", async () => {
    const requests: RequestInit[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
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
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    const client = createModelClient({
      providers: [
        createOpenAIProvider({
          apiKey: "test-key",
          endpoint: "https://api.openai.com/v1/chat/completions",
        }),
      ],
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
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    const client = createModelClient({
      providers: [
        createGlmProvider({
          apiKey: "glm-key",
        }),
      ],
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

  it("works with explicit provider:model format", async () => {
    const requests: RequestInit[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
      requests.push(init ?? {});

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "explicit ok",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    const client = createModelClient({
      providers: [
        createOpenAIProvider({ apiKey: "key" }),
        createGlmProvider({ apiKey: "key" }),
        createKimiProvider({ apiKey: "key" }),
      ],
    });

    await expect(
      client.generate({
        model: "glm:GLM-5.1",
        systemPrompt: "",
        messages: [],
        tools: [],
      }),
    ).resolves.toEqual({
      type: "final",
      output: "explicit ok",
    });
  });

  it("infers kimi provider and resolves moonshot model names", async () => {
    const requests: RequestInit[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
      requests.push(init ?? {});

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "kimi ok",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    const client = createModelClient({
      providers: [createKimiProvider({ apiKey: "kimi-key" })],
    });

    await expect(
      client.generate({
        model: "moonshot-v1-128k",
        systemPrompt: "",
        messages: [],
        tools: [],
      }),
    ).resolves.toEqual({
      type: "final",
      output: "kimi ok",
    });

    expect(requests).toHaveLength(1);
    const body = JSON.parse(String(requests[0]?.body ?? "{}")) as Record<string, unknown>;
    expect(body.model).toBe("moonshot-v1-128k");
  });

  it("creates a provider-backed model binding for agent harnesses", async () => {
    const requests: RequestInit[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
      requests.push(init ?? {});

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "bound ok",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    const binding = createProviderModelBinding({
      model: "gpt-5.4",
      providers: [
        createOpenAIProvider({
          apiKey: "test-key",
          endpoint: "https://api.openai.com/v1/chat/completions",
        }),
      ],
    });

    expect(binding.name).toBe("gpt-5.4");
    await expect(
      binding.client.generate({
        model: binding.name,
        systemPrompt: "",
        messages: [],
        tools: [],
      }),
    ).resolves.toEqual({
      type: "final",
      output: "bound ok",
    });
    expect(requests).toHaveLength(1);
  });
});

import { describe, expect, it, vi } from "vitest";

import { ApiKeyAuthProvider, HttpProvider, HttpProviderError } from "../src/index";

describe("HttpProvider", () => {
  it("injects auth headers and parses JSON responses", async () => {
    const fetchImpl = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        expect(input).toBe("https://example.test/chat");
        expect(init?.headers).toEqual({
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        });

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      },
    );

    const provider = new HttpProvider({
      authProvider: new ApiKeyAuthProvider("test-key"),
      fetchImpl,
    });

    await expect(
      provider.execute({
        url: "https://example.test/chat",
        headers: {
          "Content-Type": "application/json",
        },
        body: { hello: "world" },
      }),
    ).resolves.toEqual({
      status: 200,
      headers: {
        "content-type": "application/json",
      },
      body: { ok: true },
      raw: { ok: true },
    });
  });

  it("throws an HttpProviderError for non-2xx responses", async () => {
    const provider = new HttpProvider({
      fetchImpl: async () => {
        return new Response(JSON.stringify({ error: { message: "Too many requests" } }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "2",
          },
        });
      },
    });

    await expect(
      provider.execute({
        url: "https://example.test/chat",
        headers: {},
        body: {},
      }),
    ).rejects.toBeInstanceOf(HttpProviderError);
  });
});

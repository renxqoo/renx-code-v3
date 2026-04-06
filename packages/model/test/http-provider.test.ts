import { describe, expect, it, vi } from "vitest";

import { ApiKeyAuthProvider, HttpProvider, HttpProviderError } from "../src/index";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("HttpProvider", () => {
  // ── existing tests ──

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

  // ── transport retry ──

  it("retries on 503 and succeeds on second attempt", async () => {
    const callLog: number[] = [];
    const provider = new HttpProvider({
      fetchImpl: async () => {
        callLog.push(callLog.length);
        if (callLog.length === 1) {
          return jsonResponse({ error: "unavailable" }, 503);
        }
        return jsonResponse({ ok: true }, 200);
      },
      transportRetry: { maxRetries: 2, baseDelayMs: 1 },
    });

    const result = await provider.execute({
      url: "https://example.test/chat",
      headers: {},
      body: {},
      timeoutMs: 5000,
    });

    expect(result.status).toBe(200);
    expect(callLog.length).toBe(2);
  });

  it("retries on network TypeError and succeeds", async () => {
    const callLog: number[] = [];
    const provider = new HttpProvider({
      fetchImpl: async () => {
        callLog.push(callLog.length);
        if (callLog.length === 1) {
          throw new TypeError("fetch failed");
        }
        return jsonResponse({ ok: true }, 200);
      },
      transportRetry: { maxRetries: 2, baseDelayMs: 1 },
    });

    const result = await provider.execute({
      url: "https://example.test/chat",
      headers: {},
      body: {},
      timeoutMs: 5000,
    });

    expect(result.status).toBe(200);
    expect(callLog.length).toBe(2);
  });

  it("retries on 502 and 504", async () => {
    const callLog: number[] = [];
    const provider = new HttpProvider({
      fetchImpl: async () => {
        callLog.push(callLog.length);
        if (callLog.length === 1) {
          return jsonResponse({ error: "bad gateway" }, 502);
        }
        if (callLog.length === 2) {
          return jsonResponse({ error: "gateway timeout" }, 504);
        }
        return jsonResponse({ ok: true }, 200);
      },
      transportRetry: { maxRetries: 3, baseDelayMs: 1 },
    });

    const result = await provider.execute({
      url: "https://example.test/chat",
      headers: {},
      body: {},
      timeoutMs: 5000,
    });

    expect(result.status).toBe(200);
    expect(callLog.length).toBe(3);
  });

  it("throws after exhausting transport retries", async () => {
    const provider = new HttpProvider({
      fetchImpl: async () => {
        return jsonResponse({ error: "unavailable" }, 503);
      },
      transportRetry: { maxRetries: 2, baseDelayMs: 1 },
    });

    await expect(
      provider.execute({
        url: "https://example.test/chat",
        headers: {},
        body: {},
        timeoutMs: 5000,
      }),
    ).rejects.toBeInstanceOf(HttpProviderError);
  });

  it("does not retry 400 client errors", async () => {
    const callLog: number[] = [];
    const provider = new HttpProvider({
      fetchImpl: async () => {
        callLog.push(callLog.length);
        return jsonResponse({ error: "bad request" }, 400);
      },
      transportRetry: { maxRetries: 3, baseDelayMs: 1 },
    });

    await expect(
      provider.execute({
        url: "https://example.test/chat",
        headers: {},
        body: {},
        timeoutMs: 5000,
      }),
    ).rejects.toBeInstanceOf(HttpProviderError);

    expect(callLog.length).toBe(1);
  });

  // ── AbortSignal ──

  it("passes external signal to fetch", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeDefined();
      return jsonResponse({ ok: true });
    });

    const provider = new HttpProvider({ fetchImpl });

    await provider.execute({
      url: "https://example.test/chat",
      headers: {},
      body: {},
      signal: controller.signal,
      timeoutMs: 5000,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not inject a timeout signal when request timeout is omitted", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeUndefined();
      return jsonResponse({ ok: true });
    });

    const provider = new HttpProvider({ fetchImpl });

    await provider.execute({
      url: "https://example.test/chat",
      headers: {},
      body: {},
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("aborts when external signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const provider = new HttpProvider({
      fetchImpl: async () => {
        throw new DOMException("The operation was aborted", "AbortError");
      },
    });

    await expect(
      provider.execute({
        url: "https://example.test/chat",
        headers: {},
        body: {},
        signal: controller.signal,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow();
  });

  // ── executeStream ──

  it("yields SSE chunks from response body", async () => {
    const chunks: string[] = [];

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'),
        );
        controller.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":" there"}}]}\n\n'),
        );
        controller.close();
      },
    });

    const provider = new HttpProvider({
      fetchImpl: async () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        new Response(stream as any, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });

    for await (const chunk of provider.executeStream({
      url: "https://example.test/chat",
      headers: {},
      body: {},
      timeoutMs: 5000,
    })) {
      chunks.push(typeof chunk.raw === "string" ? chunk.raw : String(chunk.raw));
    }

    expect(chunks).toEqual([
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
    ]);
  });

  it("throws HttpProviderError on non-2xx streaming response", async () => {
    const provider = new HttpProvider({
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    });

    const iterator = provider.executeStream({
      url: "https://example.test/chat",
      headers: {},
      body: {},
      timeoutMs: 5000,
    });

    await expect(iterator[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(HttpProviderError);
  });

  it("throws when response body is not readable", async () => {
    const provider = new HttpProvider({
      fetchImpl: async () =>
        new Response(null, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });

    const iterator = provider.executeStream({
      url: "https://example.test/chat",
      headers: {},
      body: {},
      timeoutMs: 5000,
    });

    await expect(iterator[Symbol.asyncIterator]().next()).rejects.toThrow(
      "Response body is not readable",
    );
  });

  // ── executeStream transport retry ──

  it("retries executeStream on 503 and succeeds on second attempt", async () => {
    const callLog: number[] = [];
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: ok\n\n"));
        controller.close();
      },
    });

    const provider = new HttpProvider({
      fetchImpl: async () => {
        callLog.push(callLog.length);
        if (callLog.length === 1) {
          return jsonResponse({ error: "unavailable" }, 503);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return new Response(stream as any, { status: 200 });
      },
      transportRetry: { maxRetries: 2, baseDelayMs: 1 },
    });

    const chunks: string[] = [];

    for await (const chunk of provider.executeStream({
      url: "https://example.test/chat",
      headers: {},
      body: {},
      timeoutMs: 5000,
    })) {
      chunks.push(typeof chunk.raw === "string" ? chunk.raw : String(chunk.raw));
    }

    expect(callLog.length).toBe(2);
    expect(chunks).toEqual(["data: ok\n\n"]);
  });

  it("retries executeStream on network TypeError", async () => {
    const callLog: number[] = [];
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: ok\n\n"));
        controller.close();
      },
    });

    const provider = new HttpProvider({
      fetchImpl: async () => {
        callLog.push(callLog.length);
        if (callLog.length === 1) {
          throw new TypeError("fetch failed");
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return new Response(stream as any, { status: 200 });
      },
      transportRetry: { maxRetries: 2, baseDelayMs: 1 },
    });

    const chunks: string[] = [];

    for await (const chunk of provider.executeStream({
      url: "https://example.test/chat",
      headers: {},
      body: {},
      timeoutMs: 5000,
    })) {
      chunks.push(typeof chunk.raw === "string" ? chunk.raw : String(chunk.raw));
    }

    expect(callLog.length).toBe(2);
    expect(chunks).toEqual(["data: ok\n\n"]);
  });

  it("does not retry executeStream on 400 client error", async () => {
    const callLog: number[] = [];
    const provider = new HttpProvider({
      fetchImpl: async () => {
        callLog.push(callLog.length);
        return jsonResponse({ error: "bad request" }, 400);
      },
      transportRetry: { maxRetries: 3, baseDelayMs: 1 },
    });

    const iterator = provider.executeStream({
      url: "https://example.test/chat",
      headers: {},
      body: {},
      timeoutMs: 5000,
    });

    await expect(iterator[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(HttpProviderError);
    expect(callLog.length).toBe(1);
  });
});

import { describe, expect, it } from "vitest";

import type { ProviderStreamChunk } from "@renx/model";

import { parseSSEResponse, type OpenAIStreamDelta } from "../src/shared/sse-parser";

async function* fromChunks(rawChunks: string[]): AsyncGenerator<ProviderStreamChunk> {
  for (const raw of rawChunks) {
    yield { raw };
  }
}

const collect = async (chunks: AsyncIterable<OpenAIStreamDelta>): Promise<OpenAIStreamDelta[]> => {
  const result: OpenAIStreamDelta[] = [];
  for await (const chunk of chunks) {
    result.push(chunk);
  }
  return result;
};

describe("parseSSEResponse", () => {
  it("parses basic SSE data lines", async () => {
    const input = fromChunks([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    ]);

    const deltas = await collect(parseSSEResponse(input));

    expect(deltas).toEqual([
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: " world" } }] },
    ]);
  });

  it("stops at data: [DONE]", async () => {
    const input = fromChunks([
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      "data: [DONE]\n\n",
      'data: {"choices":[{"delta":{"content":"ignored"}}]}\n\n',
    ]);

    const deltas = await collect(parseSSEResponse(input));

    expect(deltas).toEqual([{ choices: [{ delta: { content: "Hi" } }] }]);
  });

  it("handles buffer boundaries across chunks", async () => {
    const input = fromChunks([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":[{"delta":{"content":"!',
      '"}}]}\n\n',
    ]);

    const deltas = await collect(parseSSEResponse(input));

    expect(deltas).toEqual([
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: "!" } }] },
    ]);
  });

  it("skips malformed JSON lines", async () => {
    const input = fromChunks([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      "data: {broken json\n\n",
      'data: {"choices":[{"delta":{"content":"after"}}]}\n\n',
    ]);

    const deltas = await collect(parseSSEResponse(input));

    expect(deltas).toEqual([
      { choices: [{ delta: { content: "ok" } }] },
      { choices: [{ delta: { content: "after" } }] },
    ]);
  });

  it("ignores empty lines and non-data lines", async () => {
    const input = fromChunks([
      "\n",
      'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
      "event: ping\n",
      ": this is a comment\n",
      'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
    ]);

    const deltas = await collect(parseSSEResponse(input));

    expect(deltas).toEqual([
      { choices: [{ delta: { content: "A" } }] },
      { choices: [{ delta: { content: "B" } }] },
    ]);
  });

  it("handles \\r\\n line endings", async () => {
    const input = fromChunks(['data: {"choices":[{"delta":{"content":"Hi"}}]}\r\n\r\n']);

    const deltas = await collect(parseSSEResponse(input));

    expect(deltas).toEqual([{ choices: [{ delta: { content: "Hi" } }] }]);
  });

  it("handles tool call streaming deltas", async () => {
    const input = fromChunks([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"SF\\"}"}}]}}]}\n\n',
    ]);

    const deltas = await collect(parseSSEResponse(input));

    expect(deltas.length).toBe(3);
    expect(deltas[0]?.choices[0]?.delta?.tool_calls?.[0]?.function?.name).toBe("get_weather");
    expect(deltas[1]?.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments).toBe('{"city"');
    expect(deltas[2]?.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments).toBe(':"SF"}');
  });

  it("returns empty on empty input", async () => {
    const input = fromChunks([]);
    const deltas = await collect(parseSSEResponse(input));
    expect(deltas).toEqual([]);
  });
});

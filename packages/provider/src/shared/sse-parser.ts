import type { ProviderStreamChunk } from "@renx/model";

export interface OpenAIStreamDelta {
  id?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
}

/**
 * Parses an SSE (Server-Sent Events) stream from OpenAI-compatible APIs.
 * Handles buffering of partial lines across chunk boundaries.
 */
export async function* parseSSEResponse(
  chunks: AsyncIterable<ProviderStreamChunk>,
): AsyncGenerator<OpenAIStreamDelta> {
  let buffer = "";

  for await (const chunk of chunks) {
    buffer += typeof chunk.raw === "string" ? chunk.raw : String(chunk.raw);

    let newlineIdx: number;

    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
      buffer = buffer.slice(newlineIdx + 1);

      if (line.length === 0) continue;

      if (!line.startsWith("data: ")) continue;

      const data = line.slice(6);

      if (data === "[DONE]") return;

      try {
        yield JSON.parse(data) as OpenAIStreamDelta;
      } catch {
        // Skip malformed JSON lines
      }
    }
  }
}

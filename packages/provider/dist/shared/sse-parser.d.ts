import type { ProviderStreamChunk } from "@renx/model";
export interface OpenAIStreamDelta {
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
export declare function parseSSEResponse(chunks: AsyncIterable<ProviderStreamChunk>): AsyncGenerator<OpenAIStreamDelta>;
//# sourceMappingURL=sse-parser.d.ts.map
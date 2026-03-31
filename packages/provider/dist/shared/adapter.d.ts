import { BaseModelAdapter, type ContextualErrorNormalizer, type MessageRenderer, type ModelRequest, type ModelResponse, type ModelStreamEvent, type Provider, type ProviderRequest, type ProviderResponse, type ResponseNormalizer, type ToolRenderer } from "@renx/model";
import type { OpenAIChatMessage, OpenAIToolDefinition } from "./types";
export interface OpenAICompatAdapterOptions {
    name: string;
    endpoint: string;
    stripPrefix?: string;
    errorNormalizer?: ContextualErrorNormalizer;
    responseNormalizer?: ResponseNormalizer;
    messageRenderer?: MessageRenderer<OpenAIChatMessage>;
    toolRenderer?: ToolRenderer<OpenAIToolDefinition>;
}
/**
 * Shared adapter for all OpenAI-compatible chat completion APIs.
 * Used by OpenAI, GLM, DeepSeek, Moonshot, and any provider that follows the
 * OpenAI chat completion protocol.
 */
export declare class OpenAICompatAdapter extends BaseModelAdapter {
    readonly name: string;
    private readonly endpoint;
    private readonly prefix;
    private readonly errorNormalizer;
    private readonly responseNormalizer;
    private readonly messageRenderer;
    private readonly toolRenderer;
    constructor(provider: Provider, options: OpenAICompatAdapterOptions);
    protected toProviderRequest(request: ModelRequest): ProviderRequest;
    protected fromProviderResponse(response: ProviderResponse, request: ModelRequest): ModelResponse;
    protected normalizeError(error: unknown, request: ModelRequest): import("@renx/model").NormalizedModelError;
    stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
    private doStream;
}
//# sourceMappingURL=adapter.d.ts.map
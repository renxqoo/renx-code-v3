import { BaseModelAdapter, type ContextualErrorNormalizer, type ModelRequest, type ModelResponse, type Provider, type ProviderRequest, type ProviderResponse, type ResponseNormalizer } from "@renx/model";
import { OpenAIMessageRenderer, OpenAIToolRenderer } from "./renderers";
export interface OpenAIModelAdapterOptions {
    endpoint?: string;
    errorNormalizer?: ContextualErrorNormalizer;
    responseNormalizer?: ResponseNormalizer;
    messageRenderer?: OpenAIMessageRenderer;
    toolRenderer?: OpenAIToolRenderer;
}
export declare class OpenAIModelAdapter extends BaseModelAdapter {
    name: string;
    private readonly endpoint;
    private readonly errorNormalizer;
    private readonly responseNormalizer;
    private readonly messageRenderer;
    private readonly toolRenderer;
    constructor(provider: Provider, options?: OpenAIModelAdapterOptions);
    protected toProviderRequest(request: ModelRequest): ProviderRequest;
    protected fromProviderResponse(response: ProviderResponse, request: ModelRequest): ModelResponse;
    protected normalizeError(error: unknown, request: ModelRequest): import("@renx/model").NormalizedModelError;
}
//# sourceMappingURL=adapter.d.ts.map
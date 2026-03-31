import type { NormalizedModelError } from "./errors";
import type { Provider } from "./provider";
import type { ModelRequest, ModelResponse, ModelStreamEvent, ProviderRequest, ProviderResponse } from "./types";
export interface ModelAdapter {
    name: string;
    generate(request: ModelRequest): Promise<ModelResponse>;
    describeRequest?(request: ModelRequest): Promise<ModelAdapterRequestDescriptor> | ModelAdapterRequestDescriptor;
    stream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}
export interface ModelAdapterRequestDescriptor {
    endpoint: string;
    method: ProviderRequest["method"];
}
export declare abstract class BaseModelAdapter implements ModelAdapter {
    protected readonly provider: Provider;
    abstract name: string;
    constructor(provider: Provider);
    generate(request: ModelRequest): Promise<ModelResponse>;
    describeRequest(request: ModelRequest): Promise<ModelAdapterRequestDescriptor>;
    protected abstract toProviderRequest(request: ModelRequest): Promise<ProviderRequest> | ProviderRequest;
    protected abstract fromProviderResponse(response: ProviderResponse, request: ModelRequest): Promise<ModelResponse> | ModelResponse;
    protected abstract normalizeError(error: unknown, request: ModelRequest): Promise<NormalizedModelError> | NormalizedModelError;
}
//# sourceMappingURL=adapter.d.ts.map
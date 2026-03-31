import type { ModelAdapter } from "./adapter";
import { type ModelRetryOptions } from "./retry";
import type { ModelRequest, ModelResponse, ModelStreamEvent, RegisteredModel, ResolvedModel } from "./types";
export interface ModelClient {
    generate(request: ModelRequest): Promise<ModelResponse>;
    stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
    resolve(model: string): ResolvedModel;
}
export interface ModelProvider {
    name: string;
    adapter: ModelAdapter;
    inferModel?: (model: string) => string | null;
}
export type ModelResolver = (model: string) => RegisteredModel;
export interface CreateModelClientOptions {
    providers: ModelProvider[];
    resolveModel: ModelResolver;
    retry?: ModelRetryOptions | false;
}
export declare class DefaultModelClient implements ModelClient {
    private readonly providers;
    private readonly resolveModelEntry;
    private readonly retryOptions;
    constructor(options: CreateModelClientOptions);
    generate(request: ModelRequest): Promise<ModelResponse>;
    resolve(model: string): ResolvedModel;
    stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
    private resolveAdapterModel;
    private observerBase;
    private observe;
}
export declare const createModelClient: (options: CreateModelClientOptions) => ModelClient;
//# sourceMappingURL=client.d.ts.map
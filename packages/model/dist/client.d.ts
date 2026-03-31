import type { ModelAdapter } from "./adapter";
import { type ModelRetryOptions } from "./retry";
import type { ModelRequest, ModelResponse, RegisteredModel, ResolvedModel } from "./types";
export interface ModelClient {
    generate(request: ModelRequest): Promise<ModelResponse>;
    resolve(model: string): ResolvedModel;
}
export interface ModelProvider {
    name: string;
    adapter: ModelAdapter;
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
    private resolveAdapterModel;
    private observe;
}
export declare const createModelClient: (options: CreateModelClientOptions) => ModelClient;
//# sourceMappingURL=client.d.ts.map
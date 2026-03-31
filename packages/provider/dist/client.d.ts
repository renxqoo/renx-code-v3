import { type ModelClient, type ModelProvider, type ModelResolver, type ModelRetryOptions } from "@renx/model";
export interface CreateModelClientOptions {
    providers: ModelProvider[];
    resolveModel?: ModelResolver;
    retry?: ModelRetryOptions | false;
}
export declare const createModelClient: (options: CreateModelClientOptions) => ModelClient;
/**
 * Resolver that only accepts explicit "provider:model" format.
 * Use this when you want strict control and no magic inference.
 */
export declare const createPrefixResolver: (validProviders: string[]) => ModelResolver;
/**
 * Default resolver: tries explicit "provider:model" first,
 * then falls back to each provider's inferModel function.
 */
export declare const createInferResolver: (providers: ModelProvider[]) => ModelResolver;
//# sourceMappingURL=client.d.ts.map
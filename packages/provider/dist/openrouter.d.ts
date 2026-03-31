import { type ModelProvider } from "@renx/model";
export interface CreateOpenRouterProviderOptions {
    apiKey: string;
    endpoint?: string;
    timeoutMs?: number;
}
export declare const createOpenRouterProvider: (options: CreateOpenRouterProviderOptions) => ModelProvider;
//# sourceMappingURL=openrouter.d.ts.map
import { type ModelProvider } from "@renx/model";
export interface CreateMiniMaxProviderOptions {
    apiKey: string;
    baseURL?: string;
    endpointPath?: string;
    timeoutMs?: number;
}
export declare const createMiniMaxProvider: (options: CreateMiniMaxProviderOptions) => ModelProvider;
//# sourceMappingURL=minimax.d.ts.map
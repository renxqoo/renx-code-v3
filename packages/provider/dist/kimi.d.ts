import { type ModelProvider } from "@renx/model";
export interface CreateKimiProviderOptions {
    apiKey: string;
    baseURL?: string;
    endpointPath?: string;
    timeoutMs?: number;
}
export declare const createKimiProvider: (options: CreateKimiProviderOptions) => ModelProvider;
//# sourceMappingURL=kimi.d.ts.map
import { type ModelProvider } from "@renx/model";
export interface CreateGlmProviderOptions {
    apiKey: string;
    baseURL?: string;
    endpointPath?: string;
    timeoutMs?: number;
}
export declare const createGlmProvider: (options: CreateGlmProviderOptions) => ModelProvider;
//# sourceMappingURL=glm.d.ts.map
import { type ModelProvider } from "@renx/model";
export interface CreateOpenAIProviderOptions {
    apiKey: string;
    endpoint?: string;
    timeoutMs?: number;
}
export declare const createOpenAIProvider: (options: CreateOpenAIProviderOptions) => ModelProvider;
//# sourceMappingURL=openai.d.ts.map
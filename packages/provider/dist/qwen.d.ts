import { type ModelProvider } from "@renx/model";
export interface CreateQwenProviderOptions {
    apiKey: string;
    baseURL?: string;
    endpointPath?: string;
    timeoutMs?: number;
}
export declare const createQwenProvider: (options: CreateQwenProviderOptions) => ModelProvider;
//# sourceMappingURL=qwen.d.ts.map
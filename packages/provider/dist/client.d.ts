import { type ModelClient, type ModelRetryOptions } from "@renx/model";
import { type CreateGlmProviderOptions } from "./glm/provider";
import { type CreateOpenAIProviderOptions } from "./openai/provider";
export interface CreateModelClientOptions {
    openai?: CreateOpenAIProviderOptions;
    glm?: CreateGlmProviderOptions;
    retry?: ModelRetryOptions | false;
}
export declare const createModelClient: (options: CreateModelClientOptions) => ModelClient;
//# sourceMappingURL=client.d.ts.map
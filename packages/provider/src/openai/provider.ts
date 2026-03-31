import { ApiKeyAuthProvider, HttpProvider, type ModelProvider } from "@renx/model";

import { OpenAIModelAdapter } from "./adapter";

export interface CreateOpenAIProviderOptions {
  apiKey: string;
  endpoint?: string;
  timeoutMs?: number;
}

export const createOpenAIProvider = (options: CreateOpenAIProviderOptions): ModelProvider => {
  const provider = new HttpProvider({
    name: "openai",
    authProvider: new ApiKeyAuthProvider(options.apiKey),
    ...(options.timeoutMs === undefined ? {} : { defaultTimeoutMs: options.timeoutMs }),
  });
  const adapterOptions =
    options.endpoint === undefined ? undefined : { endpoint: options.endpoint };

  return {
    name: "openai",
    adapter: new OpenAIModelAdapter(provider, adapterOptions),
  };
};

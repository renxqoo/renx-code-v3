import { ApiKeyAuthProvider, HttpProvider, type ModelProvider } from "@renx/model";

import { OpenAICompatAdapter } from "./shared/adapter";

export interface CreateOpenAIProviderOptions {
  apiKey: string;
  endpoint?: string;
  timeoutMs?: number;
}

export const createOpenAIProvider = (options: CreateOpenAIProviderOptions): ModelProvider => {
  const httpProvider = new HttpProvider({
    name: "openai",
    authProvider: new ApiKeyAuthProvider(options.apiKey),
    ...(options.timeoutMs === undefined ? {} : { defaultTimeoutMs: options.timeoutMs }),
  });

  return {
    name: "openai",
    adapter: new OpenAICompatAdapter(httpProvider, {
      name: "openai",
      endpoint: options.endpoint ?? "https://api.openai.com/v1/chat/completions",
    }),
    inferModel: inferOpenAI,
  };
};

const inferOpenAI = (model: string): string | null => {
  const lower = model.toLowerCase();

  if (
    lower.startsWith("gpt-") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4")
  ) {
    return model;
  }

  return null;
};

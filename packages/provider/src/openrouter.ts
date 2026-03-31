import { ApiKeyAuthProvider, HttpProvider, type ModelProvider } from "@renx/model";

import { OpenAICompatAdapter } from "./shared/adapter";

const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export interface CreateOpenRouterProviderOptions {
  apiKey: string;
  endpoint?: string;
  timeoutMs?: number;
}

export const createOpenRouterProvider = (
  options: CreateOpenRouterProviderOptions,
): ModelProvider => {
  const httpProvider = new HttpProvider({
    name: "openrouter",
    authProvider: new ApiKeyAuthProvider(options.apiKey),
    ...(options.timeoutMs === undefined ? {} : { defaultTimeoutMs: options.timeoutMs }),
  });

  return {
    name: "openrouter",
    adapter: new OpenAICompatAdapter(httpProvider, {
      name: "openrouter",
      endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
    }),
    inferModel: inferOpenRouter,
  };
};

const inferOpenRouter = (model: string): string | null => {
  // OpenRouter accepts model names in the format "provider/model"
  // e.g. "anthropic/claude-sonnet-4-20250514", "google/gemini-2.5-pro"
  // We delegate to the provider — any model not claimed by other providers passes through
  return model;
};

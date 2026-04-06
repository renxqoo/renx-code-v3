import { ApiKeyAuthProvider, HttpProvider, type ModelProvider } from "@renx/model";

import { OpenAICompatAdapter } from "./shared/adapter";

const DEFAULT_BASE_URL = "https://api.minimax.io/v1";
const DEFAULT_ENDPOINT_PATH = "/chat/completions";

export interface CreateMiniMaxProviderOptions {
  apiKey: string;
  baseURL?: string;
  endpointPath?: string;
}

export const createMiniMaxProvider = (options: CreateMiniMaxProviderOptions): ModelProvider => {
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL;
  const endpointPath = options.endpointPath ?? DEFAULT_ENDPOINT_PATH;
  const endpoint = `${trimTrailingSlash(baseURL)}${normalizePath(endpointPath)}`;

  const httpProvider = new HttpProvider({
    name: "minimax",
    authProvider: new ApiKeyAuthProvider(options.apiKey),
  });

  return {
    name: "minimax",
    adapter: new OpenAICompatAdapter(httpProvider, {
      name: "minimax",
      endpoint,
    }),
    inferModel: inferMiniMax,
  };
};

const inferMiniMax = (model: string): string | null => {
  const lower = model.toLowerCase();

  if (lower.startsWith("minimax-") || lower.startsWith("m2-") || lower.startsWith("abab")) {
    return model;
  }

  return null;
};

const trimTrailingSlash = (value: string): string =>
  value.endsWith("/") ? value.slice(0, -1) : value;

const normalizePath = (value: string): string => (value.startsWith("/") ? value : `/${value}`);

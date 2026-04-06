import { ApiKeyAuthProvider, HttpProvider, type ModelProvider } from "@renx/model";

import { OpenAICompatAdapter } from "./shared/adapter";

const DEFAULT_BASE_URL = "https://api.moonshot.cn/v1";
const DEFAULT_ENDPOINT_PATH = "/chat/completions";

export interface CreateKimiProviderOptions {
  apiKey: string;
  baseURL?: string;
  endpointPath?: string;
}

export const createKimiProvider = (options: CreateKimiProviderOptions): ModelProvider => {
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL;
  const endpointPath = options.endpointPath ?? DEFAULT_ENDPOINT_PATH;
  const endpoint = `${trimTrailingSlash(baseURL)}${normalizePath(endpointPath)}`;

  const httpProvider = new HttpProvider({
    name: "kimi",
    authProvider: new ApiKeyAuthProvider(options.apiKey),
  });

  return {
    name: "kimi",
    adapter: new OpenAICompatAdapter(httpProvider, {
      name: "kimi",
      endpoint,
    }),
    inferModel: inferKimi,
  };
};

const inferKimi = (model: string): string | null => {
  const lower = model.toLowerCase();

  if (lower.startsWith("moonshot-") || lower.startsWith("kimi-")) {
    return model;
  }

  return null;
};

const trimTrailingSlash = (value: string): string =>
  value.endsWith("/") ? value.slice(0, -1) : value;

const normalizePath = (value: string): string => (value.startsWith("/") ? value : `/${value}`);

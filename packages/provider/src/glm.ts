import { ApiKeyAuthProvider, HttpProvider, type ModelProvider } from "@renx/model";

import { OpenAICompatAdapter } from "./shared/adapter";

const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const DEFAULT_ENDPOINT_PATH = "/chat/completions";

export interface CreateGlmProviderOptions {
  apiKey: string;
  baseURL?: string;
  endpointPath?: string;
}

export const createGlmProvider = (options: CreateGlmProviderOptions): ModelProvider => {
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL;
  const endpointPath = options.endpointPath ?? DEFAULT_ENDPOINT_PATH;
  const endpoint = `${trimTrailingSlash(baseURL)}${normalizePath(endpointPath)}`;

  const httpProvider = new HttpProvider({
    name: "glm",
    authProvider: new ApiKeyAuthProvider(options.apiKey),
  });

  return {
    name: "glm",
    adapter: new OpenAICompatAdapter(httpProvider, {
      name: "glm",
      endpoint,
    }),
    inferModel: inferGlm,
  };
};

const inferGlm = (model: string): string | null => {
  if (model.toLowerCase().startsWith("glm-")) {
    return model.toUpperCase();
  }

  return null;
};

const trimTrailingSlash = (value: string): string =>
  value.endsWith("/") ? value.slice(0, -1) : value;

const normalizePath = (value: string): string => (value.startsWith("/") ? value : `/${value}`);

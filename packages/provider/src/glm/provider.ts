import { ApiKeyAuthProvider, HttpProvider, type ModelProvider } from "@renx/model";

import { GLM_5_1_CODING_PLAN } from "./config";
import { GlmModelAdapter } from "./adapter";

export interface CreateGlmProviderOptions {
  apiKey: string;
  baseURL?: string;
  endpointPath?: string;
  timeoutMs?: number;
}

export const createGlmProvider = (options: CreateGlmProviderOptions): ModelProvider => {
  const baseURL = options.baseURL ?? GLM_5_1_CODING_PLAN.baseURL;
  const endpointPath = options.endpointPath ?? GLM_5_1_CODING_PLAN.endpointPath;
  const endpoint = `${trimTrailingSlash(baseURL)}${normalizePath(endpointPath)}`;
  const provider = new HttpProvider({
    name: "glm",
    authProvider: new ApiKeyAuthProvider(options.apiKey, "Authorization", "Bearer"),
    ...(options.timeoutMs === undefined ? {} : { defaultTimeoutMs: options.timeoutMs }),
  });

  return {
    name: "glm",
    adapter: new GlmModelAdapter(provider, {
      endpoint,
    }),
  };
};

const trimTrailingSlash = (value: string): string => {
  return value.endsWith("/") ? value.slice(0, -1) : value;
};

const normalizePath = (value: string): string => {
  return value.startsWith("/") ? value : `/${value}`;
};

import { ApiKeyAuthProvider, HttpProvider, type ModelProvider } from "@renx/model";

import { OpenAICompatAdapter } from "./shared/adapter";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_ENDPOINT_PATH = "/chat/completions";

export interface CreateQwenProviderOptions {
  apiKey: string;
  baseURL?: string;
  endpointPath?: string;
}

export const createQwenProvider = (options: CreateQwenProviderOptions): ModelProvider => {
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL;
  const endpointPath = options.endpointPath ?? DEFAULT_ENDPOINT_PATH;
  const endpoint = `${trimTrailingSlash(baseURL)}${normalizePath(endpointPath)}`;

  const httpProvider = new HttpProvider({
    name: "qwen",
    authProvider: new ApiKeyAuthProvider(options.apiKey),
  });

  return {
    name: "qwen",
    adapter: new OpenAICompatAdapter(httpProvider, {
      name: "qwen",
      endpoint,
    }),
    inferModel: inferQwen,
  };
};

const inferQwen = (model: string): string | null => {
  const lower = model.toLowerCase();

  if (lower.startsWith("qwen-")) {
    return model;
  }

  return null;
};

const trimTrailingSlash = (value: string): string =>
  value.endsWith("/") ? value.slice(0, -1) : value;

const normalizePath = (value: string): string => (value.startsWith("/") ? value : `/${value}`);

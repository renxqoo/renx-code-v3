import {
  createModelClient as createBaseModelClient,
  type ModelClient,
  type ModelRetryOptions,
  type RegisteredModel,
} from "@renx/model";

import { createGlmProvider, type CreateGlmProviderOptions } from "./glm/provider";
import { createOpenAIProvider, type CreateOpenAIProviderOptions } from "./openai/provider";

export interface CreateModelClientOptions {
  openai?: CreateOpenAIProviderOptions;
  glm?: CreateGlmProviderOptions;
  retry?: ModelRetryOptions | false;
}

export const createModelClient = (options: CreateModelClientOptions): ModelClient => {
  const providers = [
    ...(options.openai === undefined ? [] : [createOpenAIProvider(options.openai)]),
    ...(options.glm === undefined ? [] : [createGlmProvider(options.glm)]),
  ];

  if (providers.length === 0) {
    throw new Error("At least one provider must be configured.");
  }

  return createBaseModelClient({
    providers,
    resolveModel(model) {
      return resolveConfiguredModel(model, options);
    },
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  });
};

const resolveConfiguredModel = (
  model: string,
  options: CreateModelClientOptions,
): RegisteredModel => {
  const explicit = parseExplicitProviderModel(model);

  if (explicit !== null) {
    assertProviderConfigured(explicit.provider, options);

    return {
      id: model,
      provider: explicit.provider,
      providerModel: normalizeProviderModel(explicit.provider, explicit.providerModel),
    };
  }

  const inferredProvider = inferProviderFromModel(model);

  if (inferredProvider === null) {
    throw new Error(`Cannot infer provider from model: ${model}`);
  }

  assertProviderConfigured(inferredProvider, options);

  return {
    id: model,
    provider: inferredProvider,
    providerModel: normalizeProviderModel(inferredProvider, model),
  };
};

const parseExplicitProviderModel = (
  model: string,
): { provider: "openai" | "glm"; providerModel: string } | null => {
  if (!model.includes(":")) {
    return null;
  }

  const [provider, ...providerModelParts] = model.split(":");
  const providerModel = providerModelParts.join(":");

  if (providerModel.length === 0) {
    throw new Error(`Invalid model: ${model}`);
  }

  if (provider === "openai" || provider === "glm") {
    return {
      provider,
      providerModel,
    };
  }

  throw new Error(`Unsupported provider prefix: ${provider}`);
};

const inferProviderFromModel = (model: string): "openai" | "glm" | null => {
  const normalized = model.toLowerCase();

  if (
    normalized.startsWith("gpt-") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4")
  ) {
    return "openai";
  }

  if (normalized.startsWith("glm-")) {
    return "glm";
  }

  return null;
};

const normalizeProviderModel = (provider: "openai" | "glm", model: string): string => {
  if (provider === "glm") {
    return model.toUpperCase();
  }

  return model;
};

const assertProviderConfigured = (
  provider: "openai" | "glm",
  options: CreateModelClientOptions,
): void => {
  if (provider === "openai" && options.openai !== undefined) {
    return;
  }

  if (provider === "glm" && options.glm !== undefined) {
    return;
  }

  throw new Error(`Provider not configured: ${provider}`);
};

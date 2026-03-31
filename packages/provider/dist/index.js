import {
  GLM_5_1_CODING_PLAN,
  GlmErrorNormalizer,
  GlmModelAdapter,
  createGlmProvider
} from "./chunk-FAQIL4BH.js";
import {
  OpenAIErrorNormalizer,
  OpenAIModelAdapter,
  createOpenAIProvider
} from "./chunk-WDUX57AT.js";
import {
  OpenAIMessageRenderer,
  OpenAIResponseNormalizer,
  OpenAIToolRenderer
} from "./chunk-WUXLEIKS.js";

// src/client.ts
import {
  createModelClient as createBaseModelClient
} from "@renx/model";
var createModelClient = (options) => {
  const providers = [
    ...options.openai === void 0 ? [] : [createOpenAIProvider(options.openai)],
    ...options.glm === void 0 ? [] : [createGlmProvider(options.glm)]
  ];
  if (providers.length === 0) {
    throw new Error("At least one provider must be configured.");
  }
  return createBaseModelClient({
    providers,
    resolveModel(model) {
      return resolveConfiguredModel(model, options);
    },
    ...options.retry === void 0 ? {} : { retry: options.retry }
  });
};
var resolveConfiguredModel = (model, options) => {
  const explicit = parseExplicitProviderModel(model);
  if (explicit !== null) {
    assertProviderConfigured(explicit.provider, options);
    return {
      id: model,
      provider: explicit.provider,
      providerModel: normalizeProviderModel(explicit.provider, explicit.providerModel)
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
    providerModel: normalizeProviderModel(inferredProvider, model)
  };
};
var parseExplicitProviderModel = (model) => {
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
      providerModel
    };
  }
  throw new Error(`Unsupported provider prefix: ${provider}`);
};
var inferProviderFromModel = (model) => {
  const normalized = model.toLowerCase();
  if (normalized.startsWith("gpt-") || normalized.startsWith("o1") || normalized.startsWith("o3") || normalized.startsWith("o4")) {
    return "openai";
  }
  if (normalized.startsWith("glm-")) {
    return "glm";
  }
  return null;
};
var normalizeProviderModel = (provider, model) => {
  if (provider === "glm") {
    return model.toUpperCase();
  }
  return model;
};
var assertProviderConfigured = (provider, options) => {
  if (provider === "openai" && options.openai !== void 0) {
    return;
  }
  if (provider === "glm" && options.glm !== void 0) {
    return;
  }
  throw new Error(`Provider not configured: ${provider}`);
};
export {
  GLM_5_1_CODING_PLAN,
  GlmErrorNormalizer,
  GlmModelAdapter,
  OpenAIErrorNormalizer,
  OpenAIMessageRenderer,
  OpenAIModelAdapter,
  OpenAIResponseNormalizer,
  OpenAIToolRenderer,
  createGlmProvider,
  createModelClient,
  createOpenAIProvider
};
//# sourceMappingURL=index.js.map
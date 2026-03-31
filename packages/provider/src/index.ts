// Client
export { createModelClient, createPrefixResolver, createInferResolver } from "./client";
export type { CreateModelClientOptions } from "./client";

// Provider factories
export { createOpenAIProvider } from "./openai";
export type { CreateOpenAIProviderOptions } from "./openai";

export { createGlmProvider } from "./glm";
export type { CreateGlmProviderOptions } from "./glm";

export { createKimiProvider } from "./kimi";
export type { CreateKimiProviderOptions } from "./kimi";

export { createQwenProvider } from "./qwen";
export type { CreateQwenProviderOptions } from "./qwen";

export { createOpenRouterProvider } from "./openrouter";
export type { CreateOpenRouterProviderOptions } from "./openrouter";

export { createMiniMaxProvider } from "./minimax";
export type { CreateMiniMaxProviderOptions } from "./minimax";

// Shared OpenAI-compatible utilities (for building custom providers)
export { OpenAICompatAdapter } from "./shared/adapter";
export type { OpenAICompatAdapterOptions } from "./shared/adapter";
export { createErrorNormalizer } from "./shared/error-normalizer";
export { OpenAIChatMessageRenderer, OpenAIToolRenderer } from "./shared/renderers";
export { OpenAIResponseNormalizer } from "./shared/response-normalizer";
export { parseSSEResponse } from "./shared/sse-parser";
export type { OpenAIStreamDelta } from "./shared/sse-parser";
export type { OpenAIChatMessage, OpenAIToolCall, OpenAIToolDefinition } from "./shared/types";

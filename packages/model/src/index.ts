// Types — fully public
export type {
  Metadata,
  AgentMessageRole,
  ModelCapabilities,
  RegisteredModel,
  ResolvedModel,
  TokenUsage,
  IterationContextStats,
} from "./types";

export type {
  AgentMessage,
  ToolDefinition,
  ToolCall,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamChunk,
} from "./types";

// Adapter — fully public
export type { ModelAdapter, ModelAdapterRequestDescriptor } from "./adapter";
export { BaseModelAdapter } from "./adapter";

// Client — selective (hide DefaultModelClient)
export {
  clearDefaultModelClient,
  createModelBinding,
  createModelClient,
  getDefaultModelClient,
  setDefaultModelClient,
} from "./client";
export type {
  CreateModelClientOptions,
  ModelBinding,
  ModelClient,
  ModelProvider,
  ModelResolver,
} from "./client";

// Errors — selective (hide removed dead interfaces)
export { ModelError, createNormalizedModelError } from "./errors";
export type { ModelErrorCode, RetryMode, NormalizedModelError, ModelErrorInit } from "./errors";

// Normalizer — fully public
export type { ResponseNormalizer, ContextualErrorNormalizer } from "./normalizer";

// Observer — fully public
export type {
  ModelObserverError,
  ModelObserverRequest,
  ModelObserverState,
  ModelObserver,
} from "./observer";

// Provider — fully public
export type { Provider, StreamingProvider } from "./provider";

// Renderer — fully public
export type { MessageRenderer, ToolRenderer } from "./renderer";

// Retry — selective (hide internals: sleep, planModelRetry, isNormalizedModelError, etc.)
export type { ModelRetryOptions, ModelRetryContext } from "./retry";

// Auth provider — fully public
export type { AuthProvider } from "./http/auth-provider";
export { StaticHeaderAuthProvider, ApiKeyAuthProvider } from "./http/auth-provider";

// HTTP provider — selective
export { HttpProvider, HttpProviderError } from "./http/http-provider";
export type { HttpProviderOptions, HttpTransportRetryOptions } from "./http/http-provider";

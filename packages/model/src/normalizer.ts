import type { NormalizedModelError } from "./errors";
import type { ModelResponse, ProviderResponse } from "./types";

export interface ResponseNormalizer {
  normalize(response: ProviderResponse): ModelResponse;
}

export interface ContextualErrorNormalizer {
  normalize(error: unknown, model?: string): NormalizedModelError;
}

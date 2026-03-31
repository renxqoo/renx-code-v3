import { type ContextualErrorNormalizer } from "@renx/model";
/**
 * Creates a provider-specific error normalizer.
 * Shared by all OpenAI-compatible providers — the only difference is the provider name.
 */
export declare const createErrorNormalizer: (provider: string) => ContextualErrorNormalizer;
//# sourceMappingURL=error-normalizer.d.ts.map
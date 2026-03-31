import { type ContextualErrorNormalizer, type NormalizedModelError } from "@renx/model";
export declare class OpenAIErrorNormalizer implements ContextualErrorNormalizer {
    normalize(error: unknown, model?: string): NormalizedModelError;
}
//# sourceMappingURL=error-normalizer.d.ts.map
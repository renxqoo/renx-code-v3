import type { NormalizedModelError } from "./errors";
import type { ModelRequest } from "./types";
export interface ModelRetryContext {
    attempt: number;
    maxAttempts: number;
    request: ModelRequest;
    error: NormalizedModelError;
    logicalModel: string;
    provider: string;
    providerModel: string;
}
export interface ModelRetryOptions {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    maxRetryAfterMs?: number;
    transformRequest?: ((context: ModelRetryContext) => Promise<ModelRequest | null> | ModelRequest | null) | undefined;
    selectFallbackModel?: ((context: ModelRetryContext) => Promise<string | null> | string | null) | undefined;
}
export interface ResolvedModelRetryOptions {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    maxRetryAfterMs: number;
    transformRequest?: ModelRetryOptions["transformRequest"];
    selectFallbackModel?: ModelRetryOptions["selectFallbackModel"];
}
export interface PlannedModelRetry {
    request: ModelRequest;
    delayMs: number;
}
export declare const DEFAULT_MODEL_RETRY_OPTIONS: ResolvedModelRetryOptions;
export declare const resolveModelRetryOptions: (options?: ModelRetryOptions | false) => ResolvedModelRetryOptions | false;
export declare const isNormalizedModelError: (error: unknown) => error is NormalizedModelError;
export declare const planModelRetry: (context: ModelRetryContext, options: ResolvedModelRetryOptions) => Promise<PlannedModelRetry | null>;
export declare const sleep: (delayMs: number) => Promise<void>;
//# sourceMappingURL=retry.d.ts.map
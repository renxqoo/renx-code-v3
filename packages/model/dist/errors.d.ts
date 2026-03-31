export type ModelErrorCode = "RATE_LIMIT" | "AUTH_ERROR" | "PERMISSION_DENIED" | "INVALID_REQUEST" | "CONTEXT_OVERFLOW" | "SERVER_ERROR" | "TIMEOUT" | "NETWORK_ERROR" | "BAD_RESPONSE" | "MODEL_OVERLOADED" | "UNKNOWN";
export type RetryMode = "NONE" | "IMMEDIATE" | "BACKOFF" | "AFTER_DELAY" | "TRANSFORM_AND_RETRY" | "FALLBACK_MODEL";
export interface NormalizedModelError extends Error {
    provider: string;
    model?: string;
    code: ModelErrorCode;
    retryable: boolean;
    retryMode: RetryMode;
    retryAfterMs?: number;
    httpStatus?: number;
    rawCode?: string | number;
    rawType?: string;
    raw: unknown;
}
export interface ModelErrorInit {
    message: string;
    provider: string;
    model?: string;
    code: ModelErrorCode;
    retryable: boolean;
    retryMode: RetryMode;
    retryAfterMs?: number;
    httpStatus?: number;
    rawCode?: string | number;
    rawType?: string;
    raw: unknown;
    cause?: unknown;
}
export interface ErrorNormalizer {
    normalize(error: unknown): NormalizedModelError;
}
export interface ProviderErrorNormalizer extends ErrorNormalizer {
}
export declare class ModelError extends Error implements NormalizedModelError {
    provider: string;
    model?: string;
    code: ModelErrorCode;
    retryable: boolean;
    retryMode: RetryMode;
    retryAfterMs?: number;
    httpStatus?: number;
    rawCode?: string | number;
    rawType?: string;
    raw: unknown;
    constructor(init: ModelErrorInit);
}
export declare const createNormalizedModelError: (init: ModelErrorInit) => NormalizedModelError;
//# sourceMappingURL=errors.d.ts.map
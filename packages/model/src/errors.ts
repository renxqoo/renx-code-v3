export type ModelErrorCode =
  | "RATE_LIMIT"
  | "AUTH_ERROR"
  | "PERMISSION_DENIED"
  | "INVALID_REQUEST"
  | "CONTEXT_OVERFLOW"
  | "SERVER_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "BAD_RESPONSE"
  | "MODEL_OVERLOADED"
  | "UNKNOWN";

export type RetryMode =
  | "NONE"
  | "IMMEDIATE"
  | "BACKOFF"
  | "AFTER_DELAY"
  | "TRANSFORM_AND_RETRY"
  | "FALLBACK_MODEL";

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

export class ModelError extends Error implements NormalizedModelError {
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

  constructor(init: ModelErrorInit) {
    super(init.message);
    this.name = "ModelError";
    this.provider = init.provider;
    this.code = init.code;
    this.retryable = init.retryable;
    this.retryMode = init.retryMode;
    this.raw = init.raw;

    if (init.model !== undefined) {
      this.model = init.model;
    }

    if (init.retryAfterMs !== undefined) {
      this.retryAfterMs = init.retryAfterMs;
    }

    if (init.httpStatus !== undefined) {
      this.httpStatus = init.httpStatus;
    }

    if (init.rawCode !== undefined) {
      this.rawCode = init.rawCode;
    }

    if (init.rawType !== undefined) {
      this.rawType = init.rawType;
    }

    if (init.cause !== undefined) {
      this.cause = init.cause;
    }
  }
}

export const createNormalizedModelError = (init: ModelErrorInit): NormalizedModelError => {
  return new ModelError(init);
};

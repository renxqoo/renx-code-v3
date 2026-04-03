import type { ModelRequest, ModelResponse } from "@renx/model";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { AgentTool } from "../tool/types";

export const toToolInputSchema = (schema: AgentTool["schema"]): Record<string, unknown> => {
  try {
    return zodToJsonSchema(schema as unknown as Parameters<typeof zodToJsonSchema>[0], {
      target: "openAi",
    }) as Record<string, unknown>;
  } catch {
    return { type: "object", properties: {} };
  }
};

export const getResponseId = (response: ModelResponse): string | undefined =>
  (response as { responseId?: string }).responseId;

export const getResponseUsage = (
  response: ModelResponse,
): { inputTokens?: number; outputTokens?: number } | undefined =>
  (response as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;

export const getDoneEventResponseId = (event: { type: string }): string | undefined =>
  (event as { responseId?: string }).responseId;

export const getDoneEventUsage = (event: {
  type: string;
}): { inputTokens?: number; outputTokens?: number } | undefined =>
  (event as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;

export const getDoneEventIteration = (event: {
  type: string;
}): Record<string, unknown> | undefined =>
  (event as { iteration?: Record<string, unknown> }).iteration;

export const getReactiveRecoveryReason = (
  error: unknown,
): "prompt_too_long" | "media_too_large" | "context_overflow" | "max_output_tokens" | null => {
  if (!error || typeof error !== "object") return null;
  const maybe = error as { code?: unknown; rawType?: unknown; message?: unknown };
  if (maybe.code === "CONTEXT_OVERFLOW") return "context_overflow";
  if (maybe.code !== "INVALID_REQUEST") return null;
  const rawType = typeof maybe.rawType === "string" ? maybe.rawType.toLowerCase() : "";
  const message = typeof maybe.message === "string" ? maybe.message.toLowerCase() : "";
  if (rawType.includes("media") || message.includes("media too large")) return "media_too_large";
  if (
    rawType.includes("context_length") ||
    rawType.includes("context_window") ||
    rawType.includes("token_limit") ||
    message.includes("context length") ||
    message.includes("context window") ||
    message.includes("too many tokens") ||
    message.includes("input is too long")
  ) {
    return "context_overflow";
  }
  if (rawType.includes("max_output_tokens") || message.includes("max output tokens"))
    return "max_output_tokens";
  if (rawType.includes("prompt") || message.includes("prompt too long")) return "prompt_too_long";
  return null;
};

export const toThresholdLevel = (budget: {
  inWarning: boolean;
  requiresAutoCompact: boolean;
  shouldBlock: boolean;
  estimatedInputTokens: number;
  errorThreshold: number;
}): "healthy" | "warning" | "auto_compact" | "error" | "blocking" => {
  if (budget.shouldBlock) return "blocking";
  if (budget.estimatedInputTokens >= budget.errorThreshold) return "error";
  if (budget.requiresAutoCompact) return "auto_compact";
  if (budget.inWarning) return "warning";
  return "healthy";
};

export type ModelRequestWithContextMetadata = ModelRequest & {
  contextMetadata?: {
    apiViewId?: string;
    compactBoundaryId?: string;
    thresholdLevel?: "healthy" | "warning" | "auto_compact" | "error" | "blocking";
  };
};

export const computeBackoffMs = (
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number => Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));

export const sleep = async (ms: number): Promise<void> => {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

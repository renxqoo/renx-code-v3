import type { ModelResponse } from "./types";

export interface ModelObserverError {
  code: string;
  message: string;
  retryable: boolean;
  retryMode: string;
  retryAfterMs?: number;
  httpStatus?: number;
  rawCode?: string | number;
  rawType?: string;
}

export interface ModelObserverRequest {
  endpoint?: string;
  method?: string;
  messageCount: number;
  toolCount: number;
  hasSystemPrompt: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface ModelObserverState {
  status: "attempting" | "retrying" | "success" | "failed";
  attempt: number;
  maxAttempts: number;
  logicalModel: string;
  provider: string;
  providerModel: string;
  request: ModelObserverRequest;
  delayMs?: number;
  responseType?: ModelResponse["type"] | "stream";
  error?: ModelObserverError;
}

export type ModelObserver = (state: ModelObserverState) => Promise<void> | void;

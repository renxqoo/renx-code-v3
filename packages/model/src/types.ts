import type { ModelObserver } from "./observer";

export type Metadata = Record<string, unknown>;

export type AgentMessageRole = "system" | "user" | "assistant" | "tool";

export interface AgentMessage {
  id: string;
  role: AgentMessageRole;
  content: string;
  createdAt: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  metadata?: Metadata;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelRequest {
  model: string;
  systemPrompt: string;
  messages: AgentMessage[];
  tools: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  metadata?: Metadata;
  contextMetadata?: {
    apiViewId?: string;
    compactBoundaryId?: string;
    thresholdLevel?: "healthy" | "warning" | "auto_compact" | "error" | "blocking";
    querySource?: string;
    contextManagement?: {
      edits: Array<
        | {
            type: "clear_tool_uses_20250919";
            trigger?: {
              type: "input_tokens";
              value: number;
            };
            keep?: {
              type: "tool_uses";
              value: number;
            };
            clear_tool_inputs?: boolean | string[];
            exclude_tools?: string[];
            clear_at_least?: {
              type: "input_tokens";
              value: number;
            };
          }
        | {
            type: "clear_thinking_20251015";
            keep: { type: "thinking_turns"; value: number } | "all";
          }
      >;
    };
  };
  observer?: ModelObserver;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  totalTokens?: number;
}

export interface IterationContextStats {
  estimatedInputTokens?: number;
  effectiveInputTokens?: number;
  messageCount?: number;
  toolCount?: number;
  roundIndex?: number;
}

export type ModelResponse =
  | {
      type: "final";
      output: string;
      responseId?: string;
      usage?: TokenUsage;
      iteration?: IterationContextStats;
      metadata?: Metadata;
    }
  | {
      type: "tool_calls";
      toolCalls: ToolCall[];
      responseId?: string;
      usage?: TokenUsage;
      iteration?: IterationContextStats;
      metadata?: Metadata;
    };

export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_delta"; partial: unknown }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; responseId?: string; usage?: TokenUsage; iteration?: IterationContextStats };

export interface ProviderRequest {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs?: number;
  metadata?: Metadata;
  signal?: AbortSignal;
}

export interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  raw?: unknown;
}

export interface ProviderStreamChunk {
  raw: unknown;
}

export interface ModelCapabilities {
  toolCalling?: boolean;
  streaming?: boolean;
  reasoning?: boolean;
}

export interface RegisteredModel {
  id: string;
  provider: string;
  providerModel: string;
  capabilities?: ModelCapabilities;
  metadata?: Metadata;
}

export interface ResolvedModel {
  logicalModel: string;
  provider: string;
  providerModel: string;
  capabilities?: ModelCapabilities;
  metadata?: Metadata;
}

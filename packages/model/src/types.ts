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
  metadata?: Metadata;
  observer?: ModelObserver;
  signal?: AbortSignal;
}

export type ModelResponse =
  | {
      type: "final";
      output: string;
      metadata?: Metadata;
    }
  | {
      type: "tool_calls";
      toolCalls: ToolCall[];
      metadata?: Metadata;
    };

export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_delta"; partial: unknown }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done" };

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

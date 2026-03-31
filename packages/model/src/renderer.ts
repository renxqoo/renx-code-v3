import type { AgentMessage, ToolDefinition } from "./types";

export interface MessageRenderer<TProviderMessage = unknown> {
  renderSystemPrompt(systemPrompt: string): TProviderMessage | null;
  renderMessages(messages: AgentMessage[]): TProviderMessage[];
}

export interface ToolRenderer<TProviderTool = unknown> {
  renderTools(tools: ToolDefinition[]): TProviderTool[];
}

import type { AgentMessage, ToolDefinition } from "@renx/model";

export interface MessageValidationIssue {
  code:
    | "DUPLICATE_MESSAGE_ID"
    | "INVALID_ROLE"
    | "MISSING_TOOL_CALL_ID"
    | "DANGLING_TOOL_CALL"
    | "ORPHAN_TOOL_RESULT";
  message: string;
  messageId?: string;
  toolCallId?: string;
}

export interface MessageValidationResult {
  valid: boolean;
  issues: MessageValidationIssue[];
}

export interface PatchToolPairsResult {
  messages: AgentMessage[];
  patched: boolean;
  patchedToolCallIds: string[];
}

export interface MessageStatePatch {
  appendMessages?: AgentMessage[];
  replaceMessages?: AgentMessage[];
}

export interface MessageRenderer<TProviderMessage = unknown> {
  render(
    systemPrompt: string,
    messages: AgentMessage[],
    tools: ToolDefinition[],
  ): TProviderMessage[];
}

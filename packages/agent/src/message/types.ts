import type { AgentMessage, ToolDefinition } from "@renx/model";

// --- Agent-layer message provenance ---

/** Why/how this message was created. Orthogonal to `role` (which is for the LLM API). */
export type MessageSource =
  | "input" // real user input
  | "model" // model response (text or tool_calls)
  | "tool" // tool execution result
  | "memory" // memory context injection
  | "rag" // RAG context injection (future)
  | "framework"; // agent framework (approval, system messages)

/**
 * Agent-layer message with provenance metadata.
 *
 * Extends the model-layer `AgentMessage` without modifying it.
 * - `messageId`: agent-controlled identifier (used for internal logic)
 * - `source`: provenance (stripped before sending to the LLM)
 *
 * `id` (from AgentMessage) is the model/provider-layer identifier.
 */
export interface RunMessage extends AgentMessage {
  /** Agent-controlled unique identifier. Used for internal logic (dedup, indexing). */
  messageId: string;
  source?: MessageSource;
}

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
  messages: RunMessage[];
  patched: boolean;
  patchedToolCallIds: string[];
}

export interface MessageStatePatch {
  appendMessages?: RunMessage[];
  replaceMessages?: RunMessage[];
}

export interface MessageRenderer<TProviderMessage = unknown> {
  render(
    systemPrompt: string,
    messages: AgentMessage[],
    tools: ToolDefinition[],
  ): TProviderMessage[];
}

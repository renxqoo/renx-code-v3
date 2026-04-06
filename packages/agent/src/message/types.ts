import type {
  AgentMessage,
  AgentMessageRole,
  Metadata,
  ToolCall,
  ToolDefinition,
} from "@renx/model";

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
  /** Provider/model-layer identifier, carried through explicitly for stable local typing. */
  id: string;
  role: AgentMessageRole;
  content: string;
  createdAt: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  metadata?: Metadata;
  /** Agent-controlled unique identifier. Used for internal logic (dedup, indexing). */
  messageId: string;
  source?: MessageSource;
  /**
   * API round index where this message is produced.
   * Helps keep compression operations aligned with request/response boundaries.
   */
  roundIndex?: number;
  /**
   * Atomic grouping id for preserving protocol-safe segments.
   * Messages in the same atomic group should be trimmed/kept together.
   */
  atomicGroupId?: string;
  /**
   * Logical group id for assistant thinking/text chunks that must stay together.
   */
  thinkingChunkGroupId?: string;
  /**
   * Marks compact boundary messages inserted by context compaction.
   */
  compactBoundary?: {
    boundaryId: string;
    strategy: "session_memory" | "auto_compact" | "reactive_compact" | "manual_compact";
    createdAt: string;
  };
  /**
   * If present, this message preserves a compacted segment reference.
   */
  preservedSegmentRef?: {
    segmentId: string;
    digest: string;
  };
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

import type { AgentMessage, ToolCall } from "@renx/model";

import { generateId } from "../helpers";
import type { AgentInput, AgentRunContext, AgentState } from "../types";

import { applyMessagePatch } from "./reducer";
import { patchToolPairs } from "./patch-tool-pairs";
import type { MessageValidationResult, PatchToolPairsResult, RunMessage } from "./types";
import { validateMessageSequence } from "./validator";

/** Options for history windowing. */
export interface HistoryWindowOptions {
  maxRecentMessages?: number;
}

/**
 * Manages the agent message lifecycle:
 * - Normalize incoming input
 * - Append user / assistant / tool messages
 * - Validate and patch message sequences
 * - Build effective messages for model consumption
 */
export interface MessageManager {
  normalizeIncoming(input: AgentInput): RunMessage[];
  appendUserMessage(state: AgentState, text: string): AgentState;
  appendAssistantMessage(state: AgentState, content: string, roundIndex?: number): AgentState;
  appendAssistantToolCallMessage(
    state: AgentState,
    content: string,
    toolCalls: ToolCall[],
    roundIndex?: number,
    atomicGroupId?: string,
    thinkingChunkGroupId?: string,
  ): AgentState;
  appendToolResultMessage(
    state: AgentState,
    toolName: string,
    toolCallId: string,
    content: string,
    roundIndex?: number,
    atomicGroupId?: string,
    thinkingChunkGroupId?: string,
  ): AgentState;
  validate(messages: RunMessage[]): MessageValidationResult;
  patchToolPairs(messages: RunMessage[]): PatchToolPairsResult;
  buildEffectiveMessages(ctx: AgentRunContext): AgentMessage[];
}

export class DefaultMessageManager implements MessageManager {
  private readonly historyWindowOptions: HistoryWindowOptions;

  constructor(options?: HistoryWindowOptions) {
    this.historyWindowOptions = {
      maxRecentMessages: options?.maxRecentMessages ?? Number.MAX_SAFE_INTEGER,
    };
  }

  normalizeIncoming(input: AgentInput): RunMessage[] {
    if (input.messages?.length) {
      return input.messages.map((m) => this.normalizeMessage(m));
    }

    if (input.inputText) {
      return [this.createUserMessage(input.inputText)];
    }

    return [];
  }

  appendUserMessage(state: AgentState, text: string): AgentState {
    return applyMessagePatch(state, { appendMessages: [this.createUserMessage(text)] });
  }

  appendAssistantMessage(state: AgentState, content: string, roundIndex?: number): AgentState {
    return applyMessagePatch(state, {
      appendMessages: [this.createAssistantMessage(content, roundIndex)],
    });
  }

  appendAssistantToolCallMessage(
    state: AgentState,
    content: string,
    toolCalls: ToolCall[],
    roundIndex?: number,
    atomicGroupId?: string,
    thinkingChunkGroupId?: string,
  ): AgentState {
    return applyMessagePatch(state, {
      appendMessages: [
        {
          id: generateId(),
          messageId: generateId("msg"),
          role: "assistant",
          content,
          createdAt: new Date().toISOString(),
          toolCalls,
          ...(roundIndex !== undefined ? { roundIndex } : {}),
          ...(atomicGroupId ? { atomicGroupId } : {}),
          ...(thinkingChunkGroupId ? { thinkingChunkGroupId } : {}),
          source: "model",
        },
      ],
    });
  }

  appendToolResultMessage(
    state: AgentState,
    toolName: string,
    toolCallId: string,
    content: string,
    roundIndex?: number,
    atomicGroupId?: string,
    thinkingChunkGroupId?: string,
  ): AgentState {
    return applyMessagePatch(state, {
      appendMessages: [
        {
          id: generateId(),
          messageId: generateId("msg"),
          role: "tool",
          name: toolName,
          toolCallId,
          content,
          createdAt: new Date().toISOString(),
          ...(roundIndex !== undefined ? { roundIndex } : {}),
          ...(atomicGroupId ? { atomicGroupId } : {}),
          ...(thinkingChunkGroupId ? { thinkingChunkGroupId } : {}),
          source: "tool",
        },
      ],
    });
  }

  validate(messages: RunMessage[]): MessageValidationResult {
    return validateMessageSequence(messages);
  }

  patchToolPairs(messages: RunMessage[]): PatchToolPairsResult {
    return patchToolPairs(messages);
  }

  /**
   * Build effective messages from the canonical message history.
   *
   * Pipeline:
   * 1. validate — check for structural issues
   * 2. patchToolPairs — fix incomplete tool call/result pairs
   * 3. applyHistoryWindow — trim to recent messages
   * 4. injectMemoryMessages — prepend memory as system context
   * 5. strip agent-only fields — remove `source` and `messageId` before sending to model
   */
  buildEffectiveMessages(ctx: AgentRunContext): AgentMessage[] {
    let messages: RunMessage[] = [...ctx.state.messages];

    // Step 1: Validate
    const validation = this.validate(messages);

    // Step 2: Patch tool pairs (always — even if validation passes,
    // we ensure pairs are complete before sending to the model)
    const patched = this.patchToolPairs(messages);
    messages = patched.messages;

    // Step 3: Apply history window
    if (!validation.valid) {
      // If there were validation issues, we already patched —
      // use the patched result as-is for windowing
    }
    messages = this.applyHistoryWindow(messages, this.historyWindowOptions);

    // Step 4: Inject memory messages
    messages = this.injectMemoryMessages(messages, ctx.state.memory);

    // Step 5: Strip agent-only fields at the boundary
    return messages.map(({ source: _, messageId: __, ...msg }) => msg);
  }

  // --- Pipeline steps ---

  /**
   * Apply history windowing — keep only the most recent N messages.
   * Older messages beyond the window are dropped.
   */
  protected applyHistoryWindow(
    messages: RunMessage[],
    options: HistoryWindowOptions,
  ): RunMessage[] {
    const max = options.maxRecentMessages ?? Number.MAX_SAFE_INTEGER;
    if (max <= 0) return messages;
    if (messages.length <= max) return messages;
    return messages.slice(messages.length - max);
  }

  /**
   * Inject memory as a system-like context message at the head.
   * Memory messages are temporary — they do not pollute state.messages.
   */
  protected injectMemoryMessages(
    messages: RunMessage[],
    memory: Record<string, unknown>,
  ): RunMessage[] {
    const keys = Object.keys(memory);
    if (keys.length === 0) return messages;

    const memoryContent = JSON.stringify(memory, null, 2);
    const memoryMessage: RunMessage = {
      id: generateId(),
      messageId: generateId("msg"),
      role: "system",
      content: `[Agent Memory]\n${memoryContent}`,
      createdAt: new Date().toISOString(),
      source: "memory",
    };

    return [memoryMessage, ...messages];
  }

  // --- Private helpers ---

  private normalizeMessage(message: RunMessage): RunMessage {
    return {
      ...message,
      id: message.id || generateId(),
      messageId: message.messageId || generateId("msg"),
      createdAt: message.createdAt || new Date().toISOString(),
      metadata: message.metadata ?? {},
      source: message.source ?? "input",
    };
  }

  private createUserMessage(text: string): RunMessage {
    return {
      id: generateId(),
      messageId: generateId("msg"),
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
      source: "input",
    };
  }

  private createAssistantMessage(text: string, roundIndex?: number): RunMessage {
    return {
      id: generateId(),
      messageId: generateId("msg"),
      role: "assistant",
      content: text,
      createdAt: new Date().toISOString(),
      ...(roundIndex !== undefined ? { roundIndex } : {}),
      source: "model",
    };
  }
}

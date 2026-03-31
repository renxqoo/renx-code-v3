import type { AgentMessage, ToolCall } from "@renx/model";

import type { AgentInput, AgentRunContext, AgentState } from "../types";

import { applyMessagePatch } from "./reducer";
import { patchToolPairs } from "./patch-tool-pairs";
import type { MessageValidationResult, PatchToolPairsResult } from "./types";
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
  normalizeIncoming(input: AgentInput): AgentMessage[];
  appendUserMessage(state: AgentState, text: string): AgentState;
  appendAssistantMessage(state: AgentState, content: string): AgentState;
  appendAssistantToolCallMessage(
    state: AgentState,
    content: string,
    toolCalls: ToolCall[],
  ): AgentState;
  appendToolResultMessage(
    state: AgentState,
    toolName: string,
    toolCallId: string,
    content: string,
  ): AgentState;
  validate(messages: AgentMessage[]): MessageValidationResult;
  patchToolPairs(messages: AgentMessage[]): PatchToolPairsResult;
  buildEffectiveMessages(ctx: AgentRunContext): AgentMessage[];
}

export class DefaultMessageManager implements MessageManager {
  private readonly historyWindowOptions: HistoryWindowOptions;

  constructor(options?: HistoryWindowOptions) {
    this.historyWindowOptions = {
      maxRecentMessages: options?.maxRecentMessages ?? 30,
    };
  }

  normalizeIncoming(input: AgentInput): AgentMessage[] {
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

  appendAssistantMessage(state: AgentState, content: string): AgentState {
    return applyMessagePatch(state, { appendMessages: [this.createAssistantMessage(content)] });
  }

  appendAssistantToolCallMessage(
    state: AgentState,
    content: string,
    toolCalls: ToolCall[],
  ): AgentState {
    return applyMessagePatch(state, {
      appendMessages: [
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content,
          createdAt: new Date().toISOString(),
          toolCalls,
        },
      ],
    });
  }

  appendToolResultMessage(
    state: AgentState,
    toolName: string,
    toolCallId: string,
    content: string,
  ): AgentState {
    return applyMessagePatch(state, {
      appendMessages: [
        {
          id: crypto.randomUUID(),
          role: "tool",
          name: toolName,
          toolCallId,
          content,
          createdAt: new Date().toISOString(),
        },
      ],
    });
  }

  validate(messages: AgentMessage[]): MessageValidationResult {
    return validateMessageSequence(messages);
  }

  patchToolPairs(messages: AgentMessage[]): PatchToolPairsResult {
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
   */
  buildEffectiveMessages(ctx: AgentRunContext): AgentMessage[] {
    let messages = [...ctx.state.messages];

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

    return messages;
  }

  // --- Pipeline steps ---

  /**
   * Apply history windowing — keep only the most recent N messages.
   * Older messages beyond the window are dropped.
   */
  protected applyHistoryWindow(
    messages: AgentMessage[],
    options: HistoryWindowOptions,
  ): AgentMessage[] {
    const max = options.maxRecentMessages ?? 30;
    if (messages.length <= max) return messages;
    return messages.slice(messages.length - max);
  }

  /**
   * Inject memory as a system-like context message at the head.
   * Memory messages are temporary — they do not pollute state.messages.
   */
  protected injectMemoryMessages(
    messages: AgentMessage[],
    memory: Record<string, unknown>,
  ): AgentMessage[] {
    const keys = Object.keys(memory);
    if (keys.length === 0) return messages;

    const memoryContent = JSON.stringify(memory, null, 2);
    const memoryMessage: AgentMessage = {
      id: "__memory_injection__",
      role: "system",
      content: `[Agent Memory]\n${memoryContent}`,
      createdAt: new Date().toISOString(),
    };

    return [memoryMessage, ...messages];
  }

  // --- Private helpers ---

  private normalizeMessage(message: AgentMessage): AgentMessage {
    return {
      ...message,
      id: message.id || crypto.randomUUID(),
      createdAt: message.createdAt || new Date().toISOString(),
      metadata: message.metadata ?? {},
    };
  }

  private createUserMessage(text: string): AgentMessage {
    return {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };
  }

  private createAssistantMessage(text: string): AgentMessage {
    return {
      id: crypto.randomUUID(),
      role: "assistant",
      content: text,
      createdAt: new Date().toISOString(),
    };
  }
}

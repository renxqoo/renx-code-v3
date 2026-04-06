import type { AgentMessage, ToolCall } from "@renx/model";

import { generateId } from "../helpers";
import type { AgentInput, AgentRunContext, AgentState } from "../types";
import { MemoryService } from "../memory";
import { DefaultSkillsService } from "../skills";

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
    messages = this.injectMemoryMessages(messages, ctx.state.memory, ctx);
    messages = this.injectSkillMessages(messages, ctx);

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
    memory: AgentState["memory"],
    ctx?: AgentRunContext,
  ): RunMessage[] {
    const metadata = {
      ...(ctx?.metadata ?? {}),
      ...(ctx?.input.metadata ?? {}),
    };
    const query =
      typeof metadata["memoryQuery"] === "string"
        ? (metadata["memoryQuery"] as string)
        : messages.filter((message) => message.role === "user").at(-1)?.content;
    const explicit = metadata["explicitMemoryRecall"] === true || metadata["recallMemory"] === true;
    const ignoreMemory = metadata["ignoreMemory"] === true || metadata["memoryMode"] === "ignore";
    const memoryContent = new MemoryService(ctx?.services.memory).buildPromptMemory(memory, {
      ...(query !== undefined ? { query } : {}),
      ...(explicit ? { explicit: true } : {}),
      ...(ignoreMemory ? { ignoreMemory: true } : {}),
      ...(typeof metadata["memoryRecallLimit"] === "number"
        ? { limit: metadata["memoryRecallLimit"] as number }
        : {}),
    });
    if (!memoryContent) return messages;
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

  protected injectSkillMessages(messages: RunMessage[], ctx?: AgentRunContext): RunMessage[] {
    const subsystem = ctx?.services.skills;
    if (!ctx || !subsystem) return messages;
    const skillMessages = new DefaultSkillsService(subsystem).buildPromptMessages(ctx, messages);
    if (skillMessages.length === 0) return messages;
    return [...skillMessages, ...messages];
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

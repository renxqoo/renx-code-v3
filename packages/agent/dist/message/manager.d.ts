import type { AgentMessage, ToolCall } from "@renx/model";
import type { AgentInput, AgentRunContext, AgentState } from "../types";
import type { MessageValidationResult, PatchToolPairsResult } from "./types";
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
    appendAssistantToolCallMessage(state: AgentState, content: string, toolCalls: ToolCall[]): AgentState;
    appendToolResultMessage(state: AgentState, toolName: string, toolCallId: string, content: string): AgentState;
    validate(messages: AgentMessage[]): MessageValidationResult;
    patchToolPairs(messages: AgentMessage[]): PatchToolPairsResult;
    buildEffectiveMessages(ctx: AgentRunContext): AgentMessage[];
}
export declare class DefaultMessageManager implements MessageManager {
    private readonly historyWindowOptions;
    constructor(options?: HistoryWindowOptions);
    normalizeIncoming(input: AgentInput): AgentMessage[];
    appendUserMessage(state: AgentState, text: string): AgentState;
    appendAssistantMessage(state: AgentState, content: string): AgentState;
    appendAssistantToolCallMessage(state: AgentState, content: string, toolCalls: ToolCall[]): AgentState;
    appendToolResultMessage(state: AgentState, toolName: string, toolCallId: string, content: string): AgentState;
    validate(messages: AgentMessage[]): MessageValidationResult;
    patchToolPairs(messages: AgentMessage[]): PatchToolPairsResult;
    /**
     * Build effective messages from the canonical message history.
     *
     * Pipeline:
     * 1. validate — check for structural issues
     * 2. patchToolPairs — fix incomplete tool call/result pairs
     * 3. applyHistoryWindow — trim to recent messages
     * 4. injectMemoryMessages — prepend memory as system context
     */
    buildEffectiveMessages(ctx: AgentRunContext): AgentMessage[];
    /**
     * Apply history windowing — keep only the most recent N messages.
     * Older messages beyond the window are dropped.
     */
    protected applyHistoryWindow(messages: AgentMessage[], options: HistoryWindowOptions): AgentMessage[];
    /**
     * Inject memory as a system-like context message at the head.
     * Memory messages are temporary — they do not pollute state.messages.
     */
    protected injectMemoryMessages(messages: AgentMessage[], memory: Record<string, unknown>): AgentMessage[];
    private normalizeMessage;
    private createUserMessage;
    private createAssistantMessage;
}
//# sourceMappingURL=manager.d.ts.map
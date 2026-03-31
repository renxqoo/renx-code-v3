import type { AgentMessage } from "@renx/model";
import type { MessageValidationResult } from "./types";
/**
 * Validates a message sequence for structural correctness.
 *
 * Checks:
 * - No duplicate message IDs
 * - All roles are valid
 * - Tool messages have `toolCallId`
 * - All assistant `toolCalls` have matching tool results
 * - All tool results reference an existing tool call
 */
export declare const validateMessageSequence: (messages: AgentMessage[]) => MessageValidationResult;
//# sourceMappingURL=validator.d.ts.map
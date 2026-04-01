import type { MessageValidationIssue, MessageValidationResult, RunMessage } from "./types";

const VALID_ROLES = new Set(["system", "user", "assistant", "tool"]);

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
export const validateMessageSequence = (messages: RunMessage[]): MessageValidationResult => {
  const issues: MessageValidationIssue[] = [];

  const seenIds = new Set<string>();
  const allToolCallIds = new Set<string>();
  const answeredToolCallIds = new Set<string>();

  for (const msg of messages) {
    // Duplicate ID check (using agent-controlled messageId)
    if (seenIds.has(msg.messageId)) {
      issues.push({
        code: "DUPLICATE_MESSAGE_ID",
        message: `Duplicate message id: ${msg.messageId}`,
        messageId: msg.messageId,
      });
    }
    seenIds.add(msg.messageId);

    // Role check
    if (!VALID_ROLES.has(msg.role)) {
      issues.push({
        code: "INVALID_ROLE",
        message: `Invalid role: ${msg.role}`,
        messageId: msg.messageId,
      });
    }

    // Collect tool call IDs from assistant messages
    if (msg.role === "assistant" && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        allToolCallIds.add(tc.id);
      }
    }

    // Tool message must have toolCallId
    if (msg.role === "tool") {
      if (!msg.toolCallId) {
        issues.push({
          code: "MISSING_TOOL_CALL_ID",
          message: `Tool message missing toolCallId: ${msg.messageId}`,
          messageId: msg.messageId,
        });
      } else {
        answeredToolCallIds.add(msg.toolCallId);
      }
    }
  }

  // Dangling tool calls (assistant requested but no tool result)
  for (const tcId of allToolCallIds) {
    if (!answeredToolCallIds.has(tcId)) {
      issues.push({
        code: "DANGLING_TOOL_CALL",
        message: `Tool call ${tcId} has no matching tool result`,
        toolCallId: tcId,
      });
    }
  }

  // Orphan tool results (tool result references non-existent tool call)
  for (const tcId of answeredToolCallIds) {
    if (!allToolCallIds.has(tcId)) {
      issues.push({
        code: "ORPHAN_TOOL_RESULT",
        message: `Tool result references unknown tool call: ${tcId}`,
        toolCallId: tcId,
      });
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
};

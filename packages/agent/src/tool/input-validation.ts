import { AgentError } from "../errors";

import type { AgentTool, ToolContext } from "./types";

/**
 * Validate and normalize tool input via zod schema.
 * Throws AgentError(VALIDATION_ERROR) when validation fails.
 */
export const validateToolInput = (tool: AgentTool, input: unknown, ctx: ToolContext): unknown => {
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) {
    throw new AgentError({
      code: "VALIDATION_ERROR",
      message: `Invalid input for tool "${tool.name}"`,
      metadata: {
        toolName: tool.name,
        toolCallId: ctx.toolCall.id,
        issues: parsed.error.issues,
      },
    });
  }
  return parsed.data;
};

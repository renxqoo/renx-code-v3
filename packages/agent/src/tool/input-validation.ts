import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";

import { AgentError } from "../errors";

import type { AgentTool, ToolContext } from "./types";

/**
 * Validate and normalize tool input via zod schema or JSON schema.
 * Throws AgentError(VALIDATION_ERROR) when validation fails.
 */
const ajv = new Ajv({ allErrors: true, strict: false });
const validatorCache = new WeakMap<Record<string, unknown>, ValidateFunction>();

type SafeParseResult =
  | { success: true; data: unknown }
  | { success: false; error: { issues: unknown[] } };

type SafeParseSchema = {
  safeParse(input: unknown): SafeParseResult;
};

const hasSafeParse = (schema: unknown): schema is SafeParseSchema =>
  !!schema &&
  typeof schema === "object" &&
  "safeParse" in schema &&
  typeof schema.safeParse === "function";

const getJsonSchemaValidator = (schema: Record<string, unknown>): ValidateFunction => {
  const cached = validatorCache.get(schema);
  if (cached) {
    return cached;
  }

  const validate = ajv.compile(schema);
  validatorCache.set(schema, validate);
  return validate;
};

const buildValidationError = (
  tool: AgentTool,
  ctx: ToolContext,
  issues: unknown,
  message = `Invalid input for tool "${tool.name}"`,
): AgentError =>
  new AgentError({
    code: "VALIDATION_ERROR",
    message,
    metadata: {
      toolName: tool.name,
      toolCallId: ctx.toolCall.id,
      issues,
    },
  });

export const validateToolInput = (tool: AgentTool, input: unknown, ctx: ToolContext): unknown => {
  if (hasSafeParse(tool.schema)) {
    const parsed = tool.schema.safeParse(input);
    if (!parsed.success) {
      throw buildValidationError(tool, ctx, parsed.error.issues);
    }
    return parsed.data;
  }

  if (tool.inputJsonSchema) {
    let validate: ValidateFunction;
    try {
      validate = getJsonSchemaValidator(tool.inputJsonSchema);
    } catch (error) {
      throw new AgentError({
        code: "TOOL_ERROR",
        message: `Invalid input schema for tool "${tool.name}"`,
        metadata: {
          toolName: tool.name,
          toolCallId: ctx.toolCall.id,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }

    const valid = validate(input);
    if (!valid) {
      throw buildValidationError(tool, ctx, (validate.errors ?? []) as ErrorObject[]);
    }
  }

  return input;
};

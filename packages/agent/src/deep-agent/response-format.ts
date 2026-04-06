import Ajv from "ajv";
import { z, type ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { createToolCapabilityProfile } from "../tool/capability";
import type { AgentTool } from "../tool/types";

import type { DeepAgentResponseFormat } from "./types";

const passthroughSchema = z.object({}).passthrough();

export const STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput";
export const STRUCTURED_OUTPUT_TOOL_PROMPT =
  "Use this tool to return your final response in the requested structured format. You MUST call this tool exactly once at the end of your response to provide the structured output.";

const isZodSchema = (value: DeepAgentResponseFormat): value is ZodType<unknown> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ZodType<unknown>).safeParse === "function";

export const toResponseFormatJsonSchema = (
  responseFormat: DeepAgentResponseFormat,
): Record<string, unknown> => {
  if (isZodSchema(responseFormat)) {
    const converted = zodToJsonSchema(
      responseFormat as unknown as Parameters<typeof zodToJsonSchema>[0],
      {
        target: "openAi",
      },
    ) as Record<string, unknown>;
    const { $schema: _schema, ...jsonSchema } = converted;
    return jsonSchema;
  }
  return responseFormat;
};

export const createStructuredOutputTool = (responseFormat: DeepAgentResponseFormat): AgentTool => {
  const jsonSchema = toResponseFormatJsonSchema(responseFormat);
  const validateStructuredInput = isZodSchema(responseFormat)
    ? (input: unknown) => responseFormat.parse(input)
    : (() => {
        const ajv = new Ajv({ allErrors: true, strict: false });
        const schemaValid = ajv.validateSchema(jsonSchema);
        if (!schemaValid) {
          throw new Error(ajv.errorsText(ajv.errors));
        }
        const validate = ajv.compile(jsonSchema);
        return (input: unknown) => {
          const valid = validate(input);
          if (!valid) {
            const errors =
              validate.errors
                ?.map((error) => `${error.instancePath || "root"}: ${error.message}`)
                .join(", ") ?? "unknown validation error";
            throw new Error(`Output does not match required schema: ${errors}`);
          }
          return input;
        };
      })();

  return {
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    description: STRUCTURED_OUTPUT_TOOL_PROMPT,
    schema: passthroughSchema,
    inputJsonSchema: jsonSchema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["utility"],
      sandboxExpectation: "read-only",
      auditCategory: "utility",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    invoke: async (input) => {
      const parsed = passthroughSchema.parse(input);
      const structured = validateStructuredInput(parsed);

      return {
        content: "Structured output provided successfully",
        structured,
      };
    },
  };
};

export const buildResponseFormatPrompt = (): string => STRUCTURED_OUTPUT_TOOL_PROMPT;

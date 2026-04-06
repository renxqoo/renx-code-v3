import Ajv from "ajv";
import type { AgentTool } from "@renx/agent";
import { createToolCapabilityProfile } from "@renx/agent";
import { z } from "zod";

const STRUCTURED_OUTPUT_TOOL_PROMPT = `Use this tool to return your final response in the requested structured format. You MUST call this tool exactly once at the end of your response to provide the structured output.`;

const baseSchema = z.object({}).passthrough();
const toolCache = new WeakMap<object, { tool: AgentTool } | { error: string }>();

const buildStructuredOutputTool = (
  jsonSchema: Record<string, unknown>,
): { tool: AgentTool } | { error: string } => {
  try {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const schemaValid = ajv.validateSchema(jsonSchema);
    if (!schemaValid) {
      return { error: ajv.errorsText(ajv.errors) };
    }
    const validate = ajv.compile(jsonSchema);

    return {
      tool: {
        name: "StructuredOutput",
        description: STRUCTURED_OUTPUT_TOOL_PROMPT,
        schema: baseSchema,
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
          const parsed = baseSchema.parse(input);
          const valid = validate(parsed);
          if (!valid) {
            const errors =
              validate.errors
                ?.map((error) => `${error.instancePath || "root"}: ${error.message}`)
                .join(", ") ?? "unknown validation error";
            throw new Error(`Output does not match required schema: ${errors}`);
          }

          return {
            content: "Structured output provided successfully",
            structured: parsed,
          };
        },
      },
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export const createSyntheticOutputTool = (
  jsonSchema: Record<string, unknown>,
): { tool: AgentTool } | { error: string } => {
  const cached = toolCache.get(jsonSchema);
  if (cached) {
    return cached;
  }
  const result = buildStructuredOutputTool(jsonSchema);
  toolCache.set(jsonSchema, result);
  return result;
};

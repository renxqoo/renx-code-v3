import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AgentTool, ToolResult } from "../../src/tool/types";
import { toToolInputSchema } from "../../src/runtime/utils";

describe("tool input JSON schema overrides", () => {
  it("prefers an explicit inputJsonSchema over zod schema conversion", () => {
    const inputJsonSchema = {
      type: "object",
      properties: {
        verdict: { type: "string" },
      },
      required: ["verdict"],
      additionalProperties: false,
    } satisfies Record<string, unknown>;

    const tool: AgentTool = {
      name: "StructuredOutput",
      description: "Structured output",
      schema: z.object({}).passthrough(),
      inputJsonSchema,
      invoke: async (): Promise<ToolResult> => ({ content: "ok" }),
    };

    expect(toToolInputSchema(tool)).toBe(inputJsonSchema);
  });
});

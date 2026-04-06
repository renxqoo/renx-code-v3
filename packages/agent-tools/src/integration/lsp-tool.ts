import type { AgentTool } from "@renx/agent";
import { createToolCapabilityProfile } from "@renx/agent";
import { z } from "zod";

import { getLspProvider, okToolResult } from "../platform/shared";

const LSP_TOOL_PROMPT = `Interact with Language Server Protocol (LSP) servers to get code intelligence features.

Supported operations:
- goToDefinition: Find where a symbol is defined
- findReferences: Find all references to a symbol
- hover: Get hover information (documentation, type info) for a symbol
- documentSymbol: Get all symbols (functions, classes, variables) in a document
- workspaceSymbol: Search for symbols across the entire workspace
- goToImplementation: Find implementations of an interface or abstract method
- prepareCallHierarchy: Get call hierarchy item at a position (functions/methods)
- incomingCalls: Find all functions/methods that call the function at a position
- outgoingCalls: Find all functions/methods called by the function at a position

All operations require:
- filePath: The file to operate on
- line: The line number (1-based, as shown in editors)
- character: The character offset (1-based, as shown in editors)

Note: LSP servers must be configured for the file type. If no server is available, an error will be returned.`;

export const createLspTool = (): AgentTool => {
  const schema = z.object({
    operation: z.enum([
      "goToDefinition",
      "findReferences",
      "hover",
      "documentSymbol",
      "workspaceSymbol",
      "goToImplementation",
      "prepareCallHierarchy",
      "incomingCalls",
      "outgoingCalls",
    ]),
    filePath: z.string().min(1),
    line: z.number().int().min(1),
    character: z.number().int().min(1),
  });

  return {
    name: "LSP",
    description: LSP_TOOL_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["lsp", "code_intelligence"],
      sandboxExpectation: "read-only",
      auditCategory: "code_intelligence",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      const provider = getLspProvider(ctx);
      if (!provider) throw new Error("No LSP provider is configured.");
      const result = await provider.run(parsed.operation, parsed);
      return okToolResult(`${parsed.operation}\n${JSON.stringify(result, null, 2)}`, {
        structured: result,
      });
    },
  };
};

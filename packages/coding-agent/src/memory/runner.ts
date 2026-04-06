/**
 * Forked agent runner implementations for memory extraction and dream.
 *
 * Uses createDeepAgent internally with tool-gate middleware so that
 * extraction / dream sub-agents operate with the same tools but
 * restricted permissions.
 */

import type { ToolCall } from "@renx/model";
import type {
  AgentMiddleware,
  MiddlewareDecision,
  DeepAgentHandle,
  ForkedAgentRunner,
  DreamRunner,
} from "@renx/agent";
import { createDeepAgent } from "@renx/agent";
import { createCodingToolset } from "@renx/agent-tools";
import type { ModelBinding } from "@renx/model";

// ---------------------------------------------------------------------------
// Extract tools subset for memory sub-agents
// ---------------------------------------------------------------------------

const MEMORY_TOOL_NAMES = new Set(["Read", "Write", "Edit", "Glob", "Grep", "Bash"]);

const filterMemoryTools = (tools: import("@renx/agent").AgentTool[]) =>
  tools.filter((t) => MEMORY_TOOL_NAMES.has(t.name));

// ---------------------------------------------------------------------------
// ForkedAgentRunner (extraction)
// ---------------------------------------------------------------------------

export interface CodingMemoryRunnerOptions {
  modelBinding: ModelBinding;
}

/**
 * Create a ForkedAgentRunner that uses createDeepAgent internally.
 */
export const createCodingMemoryRunner = (options: CodingMemoryRunnerOptions): ForkedAgentRunner => {
  const { modelBinding } = options;

  return {
    async run(params: {
      systemPrompt: string;
      messages: Array<{ role: string; content: string }>;
      maxTurns: number;
      canUseTool: (toolName: string, input: unknown) => boolean | string;
    }) {
      const { systemPrompt, messages, maxTurns, canUseTool } = params;

      // Create a read-only tool subset
      const allTools = createCodingToolset();
      const toolset = filterMemoryTools(allTools);

      // Gate middleware: skip tools that the extraction gate blocks
      const gate: AgentMiddleware = {
        name: "memory-tool-gate",
        async beforeTool(_ctx: unknown, call: ToolCall): Promise<MiddlewareDecision | void> {
          const decision = canUseTool(call.name, call.input);
          if (decision !== true) {
            return { stopCurrentStep: true };
          }
          return undefined;
        },
      };

      const subAgent: DeepAgentHandle = createDeepAgent({
        model: modelBinding,
        systemPrompt,
        tools: toolset,
        middleware: [gate],
        maxSteps: maxTurns,
      });

      const result = await subAgent.invoke({
        messages: messages.map((m, i) => ({
          id: `mem-msg-${i}`,
          messageId: `mem-msg-${i}`,
          role: m.role as "user" | "assistant",
          content: m.content,
          createdAt: new Date().toISOString(),
        })),
      });

      return {
        success: result.status === "completed",
      };
    },
  };
};

// ---------------------------------------------------------------------------
// DreamRunner (consolidation)
// ---------------------------------------------------------------------------

/**
 * Create a DreamRunner using the same sub-agent approach.
 * Returns `text` instead of `writtenPaths`.
 */
export const createCodingDreamRunner = (options: CodingMemoryRunnerOptions): DreamRunner => {
  const baseRunner = createCodingMemoryRunner(options);

  return {
    async run(params) {
      const result = await baseRunner.run(params);
      return {
        success: result.success,
        ...(result.success ? { text: "consolidation complete" } : {}),
      };
    },
  };
};

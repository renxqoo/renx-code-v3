import { Script, createContext } from "node:vm";
import { isDeepStrictEqual } from "node:util";

import type {
  AgentState,
  AgentStatePatch,
  AgentTool,
  AgentRunContext,
  ToolResult,
} from "@renx/agent";
import { createToolCapabilityProfile } from "@renx/agent";
import { z } from "zod";

const REPL_TOOL_PROMPT = `Use this tool when you want to batch multiple primitive tool operations into a single controlled evaluation step. This REPL is for lightweight computation and orchestration around primitive tools, not for replacing the dedicated workspace or shell tools. Keep usage small, deterministic, and focused on primitive tools or short computations.`;

const REPL_PRIMITIVE_TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "NotebookEdit",
  "Agent",
] as const;
const REPL_PRIMITIVE_SET = new Set<string>(REPL_PRIMITIVE_TOOL_NAMES);

const schema = z.object({
  language: z.enum(["javascript"]),
  code: z.string().min(1),
});

const cloneRunContext = (ctx: AgentRunContext): AgentRunContext => ({
  ...ctx,
  state: {
    ...ctx.state,
    messages: [...ctx.state.messages],
    scratchpad: { ...ctx.state.scratchpad },
    memory: { ...ctx.state.memory },
  },
});

const buildAppendOrReplaceMessagesPatch = (
  beforeMessages: AgentState["messages"],
  afterMessages: AgentState["messages"],
): Pick<AgentStatePatch, "appendMessages" | "replaceMessages"> | undefined => {
  if (isDeepStrictEqual(beforeMessages, afterMessages)) {
    return undefined;
  }
  const canAppend =
    afterMessages.length >= beforeMessages.length &&
    beforeMessages.every((message, index) => isDeepStrictEqual(message, afterMessages[index]));
  if (canAppend) {
    return { appendMessages: afterMessages.slice(beforeMessages.length) };
  }
  return { replaceMessages: afterMessages };
};

const buildChangedTopLevelEntries = <T extends Record<string, unknown>>(
  beforeValue: T,
  afterValue: T,
): Partial<T> | undefined => {
  const changedEntries = Object.entries(afterValue).filter(([key, value]) => {
    return !isDeepStrictEqual(beforeValue[key], value);
  });
  if (changedEntries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(changedEntries) as Partial<T>;
};

const buildAggregatedStatePatch = (
  beforeState: AgentState,
  afterState: AgentState,
): AgentStatePatch | undefined => {
  const patch: AgentStatePatch = {};
  const messagePatch = buildAppendOrReplaceMessagesPatch(beforeState.messages, afterState.messages);
  if (messagePatch?.appendMessages) {
    patch.appendMessages = messagePatch.appendMessages;
  }
  if (messagePatch?.replaceMessages) {
    patch.replaceMessages = messagePatch.replaceMessages;
  }
  const scratchpadPatch = buildChangedTopLevelEntries(
    beforeState.scratchpad,
    afterState.scratchpad,
  );
  if (scratchpadPatch) {
    patch.setScratchpad = scratchpadPatch;
  }
  const memoryPatch = buildChangedTopLevelEntries(beforeState.memory, afterState.memory);
  if (memoryPatch) {
    patch.mergeMemory = memoryPatch;
  }
  if (
    !isDeepStrictEqual(beforeState.context, afterState.context) &&
    afterState.context !== undefined
  ) {
    patch.setContext = afterState.context;
  }
  if (afterState.status !== beforeState.status) {
    patch.setStatus = afterState.status;
  }
  if (!isDeepStrictEqual(beforeState.error, afterState.error) && afterState.error !== undefined) {
    patch.setError = afterState.error;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
};

const formatConsoleValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const formatResultContent = (value: unknown, logs: string[]): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === undefined) {
    return logs.length > 0 ? logs.join("\n") : "undefined";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

export const createReplTool = (): AgentTool => ({
  name: "REPL",
  description: REPL_TOOL_PROMPT,
  schema,
  profile: createToolCapabilityProfile({
    riskLevel: "medium",
    capabilityTags: ["repl"],
    sandboxExpectation: "read-only",
    auditCategory: "utility",
  }),
  isConcurrencySafe: () => false,
  isReadOnly: () => true,
  invoke: async (input, ctx) => {
    const parsed = schema.parse(input);
    if (parsed.language !== "javascript") {
      throw new Error(`Unsupported REPL language: ${parsed.language}`);
    }

    const workingRunContext = cloneRunContext(ctx.runContext);
    const toolCalls: Array<Record<string, unknown>> = [];
    const logs: string[] = [];
    const callTool = async (name: string, toolInput: unknown): Promise<ToolResult> => {
      if (!REPL_PRIMITIVE_SET.has(name)) {
        throw new Error(
          `REPL can only invoke primitive tools: ${REPL_PRIMITIVE_TOOL_NAMES.join(", ")}`,
        );
      }
      if (!ctx.tools) {
        throw new Error(
          "REPL tool orchestration is unavailable outside the runtime tool executor.",
        );
      }
      const execution = await ctx.tools.invoke({
        name,
        input: toolInput,
        runContext: workingRunContext,
      });
      toolCalls.push({
        name,
        input: toolInput,
        content: execution.output.content,
        structured: execution.output.structured,
      });
      return execution.output;
    };

    const context = createContext({
      callTool,
      primitiveTools: [...REPL_PRIMITIVE_TOOL_NAMES],
      console: {
        log: (...args: unknown[]) => {
          logs.push(args.map(formatConsoleValue).join(" "));
        },
      },
      JSON,
      Math,
      Date,
      Number,
      String,
      Boolean,
      Array,
      Object,
      RegExp,
      Promise,
    });

    const script = new Script(`(async () => { ${parsed.code}\n})()`);
    const result = await Promise.resolve(script.runInContext(context, { timeout: 1_000 }));
    const statePatch = buildAggregatedStatePatch(ctx.runContext.state, workingRunContext.state);
    return {
      content: formatResultContent(result, logs),
      structured: {
        result,
        logs,
        toolCalls,
      },
      ...(statePatch ? { statePatch } : {}),
    };
  },
});

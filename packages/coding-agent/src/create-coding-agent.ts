import type { AgentTool } from "@renx/agent";
import { createDeepAgent } from "@renx/agent";

import { createBuiltInCodingSubagents, toInlineSubagents } from "./builtins";
import { DEFAULT_CODING_AGENT_SYSTEM_PROMPT } from "./prompts";
import { resolveCodingToolset } from "./tool-selection";
import type { CodingBuiltInAgentDefinition, CreateCodingAgentOptions } from "./types";

const combineSystemPrompt = (
  customPrompt: CreateCodingAgentOptions["systemPrompt"],
): NonNullable<CreateCodingAgentOptions["systemPrompt"]> => {
  if (!customPrompt) {
    return DEFAULT_CODING_AGENT_SYSTEM_PROMPT;
  }
  if (typeof customPrompt === "string") {
    return [customPrompt, DEFAULT_CODING_AGENT_SYSTEM_PROMPT].join("\n\n");
  }
  return async (ctx) => {
    const resolved = await customPrompt(ctx);
    return [resolved, DEFAULT_CODING_AGENT_SYSTEM_PROMPT].join("\n\n");
  };
};

export const getBuiltInCodingSubagents = (tools?: AgentTool[]): CodingBuiltInAgentDefinition[] =>
  createBuiltInCodingSubagents(resolveCodingToolset(tools));

export const createCodingAgent = (options: CreateCodingAgentOptions) => {
  const resolvedTools = resolveCodingToolset(options.tools);
  const builtIns = toInlineSubagents(getBuiltInCodingSubagents(resolvedTools));

  return createDeepAgent({
    ...options,
    systemPrompt: combineSystemPrompt(options.systemPrompt),
    tools: resolvedTools,
    subagents: [...builtIns, ...(options.subagents ?? [])],
  });
};

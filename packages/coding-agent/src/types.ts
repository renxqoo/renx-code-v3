import type { CreateDeepAgentOptions, DeepAgentHandle, DeepAgentSubagent } from "@renx/agent";
import type { AgentTool } from "@renx/agent";

export type CodingBuiltInAgentName = "general-purpose" | "Explore" | "Plan" | "verification";

export interface CodingBuiltInAgentDefinition {
  name: CodingBuiltInAgentName;
  description: string;
  systemPrompt: string;
  tools: AgentTool[];
  maxSteps?: number;
}

export interface CreateCodingAgentOptions extends Omit<
  CreateDeepAgentOptions,
  "systemPrompt" | "tools" | "subagents"
> {
  systemPrompt?: CreateDeepAgentOptions["systemPrompt"];
  tools?: AgentTool[];
  subagents?: DeepAgentSubagent[];
}

export interface CodingAgentFactory {
  (options: CreateCodingAgentOptions): DeepAgentHandle;
}

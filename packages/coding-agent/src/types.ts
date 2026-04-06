import type { CreateDeepAgentOptions, DeepAgentHandle, DeepAgentSubagent } from "@renx/agent";
import type { AgentTool } from "@renx/agent";
import type { CodingAgentMemoryConfig } from "./memory/types";

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
  "systemPrompt" | "tools" | "subagents" | "memory" | "memorySubsystem" | "sessionMemory"
> {
  systemPrompt?: CreateDeepAgentOptions["systemPrompt"];
  tools?: AgentTool[];
  subagents?: DeepAgentSubagent[];
  /** Memory configuration. When provided, memory is persisted and hydrated automatically. */
  memory?: CodingAgentMemoryConfig;
}

export interface CodingAgentFactory {
  (options: CreateCodingAgentOptions): Promise<DeepAgentHandle>;
}

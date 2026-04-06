import type { DeepAgentInlineSubagent } from "@renx/agent";
import type { AgentTool } from "@renx/agent";

import {
  EXPLORE_AGENT_PROMPT,
  GENERAL_PURPOSE_AGENT_PROMPT,
  PLAN_AGENT_PROMPT,
  VERIFICATION_AGENT_PROMPT,
} from "./prompts";
import {
  selectExploreTools,
  selectGeneralPurposeTools,
  selectPlanTools,
  selectVerificationTools,
} from "./tool-selection";
import type { CodingBuiltInAgentDefinition } from "./types";

export const createBuiltInCodingSubagents = (
  tools: AgentTool[],
): CodingBuiltInAgentDefinition[] => [
  {
    name: "general-purpose",
    description:
      "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries, use this agent.",
    systemPrompt: GENERAL_PURPOSE_AGENT_PROMPT,
    tools: selectGeneralPurposeTools(tools),
    maxSteps: 12,
  },
  {
    name: "Explore",
    description:
      "Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns, search code for keywords, or answer questions about how the codebase works.",
    systemPrompt: EXPLORE_AGENT_PROMPT,
    tools: selectExploreTools(tools),
    maxSteps: 6,
  },
  {
    name: "Plan",
    description:
      "Software architect agent for designing implementation plans. Use this when you need a read-only implementation strategy with sequencing, critical files, and architectural trade-offs.",
    systemPrompt: PLAN_AGENT_PROMPT,
    tools: selectPlanTools(tools),
    maxSteps: 8,
  },
  {
    name: "verification",
    description:
      "Use this agent to verify implementation work before reporting completion. It runs builds, tests, linters, and adversarial checks to produce a PASS, FAIL, or PARTIAL verdict with evidence.",
    systemPrompt: VERIFICATION_AGENT_PROMPT,
    tools: selectVerificationTools(tools),
    maxSteps: 12,
  },
];

export const toInlineSubagents = (
  builtIns: CodingBuiltInAgentDefinition[],
): DeepAgentInlineSubagent[] =>
  builtIns.map((agent) => ({
    name: agent.name,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
    tools: agent.tools,
    ...(agent.maxSteps !== undefined ? { maxSteps: agent.maxSteps } : {}),
  }));

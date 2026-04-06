import { z } from "zod";

import { generateId } from "../helpers";
import { createToolCapabilityProfile } from "../tool/capability";
import type { AgentTool } from "../tool/types";
import type { RunMessage } from "../message/types";

import type { DeepAgentHandle, DeepAgentSubagent } from "./types";

const TASK_TOOL_SCHEMA = z.object({
  description: z.string().describe("The task to execute with the selected agent"),
  subagent_type: z.string().describe("Name of the agent to use"),
});

export const TASK_TOOL_NAME = "task";

export const TASK_SYSTEM_PROMPT = [
  "## `task` (subagent spawner)",
  "",
  "You have access to a `task` tool to launch short-lived subagents that handle isolated tasks.",
  "Use it when a task is complex, multi-step, context-heavy, or can be delegated independently.",
  "Do not use it for trivial work that is faster to complete directly.",
  "When you use `task`, provide a detailed description and pick the correct `subagent_type`.",
  "The subagent returns a single result that you should summarize back to the user.",
].join("\n");

const buildTaskToolDescription = (subagents: DeepAgentSubagent[]): string => {
  const descriptions = subagents.map((subagent) => `"${subagent.name}": ${subagent.description}`);
  return [
    "Launch an ephemeral subagent to handle complex, multi-step independent tasks with isolated context windows.",
    "",
    "Available agent types and the tools they have access to:",
    ...descriptions,
    "",
    "When using the Task tool, you must specify a subagent_type parameter to select which agent type to use.",
    "",
    "Usage notes:",
    "1. Launch multiple agents concurrently whenever possible.",
    "2. The result returned by the agent is not directly visible to the user; summarize it back to the user yourself.",
    "3. Each agent invocation is stateless, so provide detailed instructions and the exact output you need.",
    "4. Use this tool for complex isolated tasks, not trivial direct tool calls.",
  ].join("\n");
};

const createSubagentMessage = (description: string): RunMessage => ({
  id: generateId(),
  messageId: generateId("msg"),
  role: "user",
  content: description,
  createdAt: new Date().toISOString(),
  source: "input",
});

const formatSubagentResult = async (
  runnable: DeepAgentHandle,
  description: string,
): Promise<{ content: string; structured?: unknown; metadata: Record<string, unknown> }> => {
  const result = await runnable.invoke({
    messages: [createSubagentMessage(description)],
  });
  const structured = result.structuredResponse;
  if (structured !== undefined) {
    return {
      content: JSON.stringify(structured),
      structured,
      metadata: {
        subagentRunId: result.runId,
        status: result.status,
      },
    };
  }

  const lastAssistantMessage = [...(result.messages ?? [])]
    .reverse()
    .find((message) => message.role === "assistant");
  return {
    content: lastAssistantMessage?.content ?? result.output ?? "",
    metadata: {
      subagentRunId: result.runId,
      status: result.status,
    },
  };
};

export const createTaskTool = (options: {
  subagents: DeepAgentSubagent[];
  resolveRunnable(subagent: DeepAgentSubagent): DeepAgentHandle;
}): AgentTool => ({
  name: TASK_TOOL_NAME,
  description: buildTaskToolDescription(options.subagents),
  schema: TASK_TOOL_SCHEMA,
  profile: createToolCapabilityProfile({
    riskLevel: "low",
    capabilityTags: ["delegation"],
    sandboxExpectation: "read-only",
    auditCategory: "coordination",
  }),
  invoke: async (input) => {
    const parsed = TASK_TOOL_SCHEMA.parse(input);
    const subagent = options.subagents.find((candidate) => candidate.name === parsed.subagent_type);
    if (!subagent) {
      const allowedTypes = options.subagents.map((candidate) => `\`${candidate.name}\``).join(", ");
      throw new Error(
        `Error: invoked agent of type ${parsed.subagent_type}, the only allowed types are ${allowedTypes}`,
      );
    }

    const runnable = options.resolveRunnable(subagent);
    const result = await formatSubagentResult(runnable, parsed.description);
    return result;
  },
});

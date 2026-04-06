import { generateId } from "../helpers";
import type { RunMessage } from "../message/types";
import type { AgentStatePatch } from "../types";

import { buildSkillsStatePatch } from "./state";
import type {
  SkillDefinition,
  SkillExecutionContext,
  SkillExecutionRequest,
  SkillExecutionResult,
  SkillInvocationRecord,
} from "./types";

const expandArguments = (prompt: string, args: string | undefined): string => {
  const replacement = args ?? "";
  return prompt
    .replaceAll("$ARGUMENTS", replacement)
    .replaceAll("$ARGS", replacement)
    .replaceAll("{{args}}", replacement);
};

const buildPromptMessage = (skill: SkillDefinition, expandedPrompt: string): RunMessage => ({
  id: generateId(),
  messageId: generateId("msg"),
  role: "user",
  content: `[Skill: ${skill.name}]\n${expandedPrompt}`,
  createdAt: new Date().toISOString(),
  source: "framework",
  metadata: {
    skillName: skill.name,
    skillPath: skill.path,
    executionMode: skill.executionMode,
  },
});

const mergeStatePatches = (
  left: AgentStatePatch | undefined,
  right: AgentStatePatch | undefined,
): AgentStatePatch | undefined => {
  if (!left) return right;
  if (!right) return left;
  return {
    ...(left.appendMessages || right.appendMessages
      ? { appendMessages: [...(left.appendMessages ?? []), ...(right.appendMessages ?? [])] }
      : {}),
    ...(left.setScratchpad || right.setScratchpad
      ? { setScratchpad: { ...(left.setScratchpad ?? {}), ...(right.setScratchpad ?? {}) } }
      : {}),
    ...(left.mergeMemory || right.mergeMemory
      ? { mergeMemory: { ...(left.mergeMemory ?? {}), ...(right.mergeMemory ?? {}) } }
      : {}),
    ...(right.replaceMessages
      ? { replaceMessages: right.replaceMessages }
      : left.replaceMessages
        ? { replaceMessages: left.replaceMessages }
        : {}),
    ...(right.setContext
      ? { setContext: right.setContext }
      : left.setContext
        ? { setContext: left.setContext }
        : {}),
    ...(right.setStatus
      ? { setStatus: right.setStatus }
      : left.setStatus
        ? { setStatus: left.setStatus }
        : {}),
    ...(right.setError
      ? { setError: right.setError }
      : left.setError
        ? { setError: left.setError }
        : {}),
  };
};

const toInvocationRecord = (
  skill: SkillDefinition,
  args: string | undefined,
): SkillInvocationRecord => ({
  skillName: skill.name,
  skillPath: skill.path,
  executionMode: skill.executionMode,
  invokedAt: new Date().toISOString(),
  ...(args ? { args } : {}),
});

export class DefaultSkillExecutor {
  async execute(
    skill: SkillDefinition,
    request: SkillExecutionRequest,
    context: SkillExecutionContext,
  ): Promise<SkillExecutionResult> {
    const expandedPrompt = expandArguments(skill.prompt, request.args);
    const invocation = toInvocationRecord(skill, request.args);
    const statePatch = buildSkillsStatePatch(context.runContext.state.scratchpad, invocation);

    if (skill.executionMode === "inline") {
      const inlineStatePatch = mergeStatePatches(statePatch, {
        appendMessages: [buildPromptMessage(skill, expandedPrompt)],
      });
      return {
        content: `Executed skill: ${skill.name}`,
        ...(inlineStatePatch ? { statePatch: inlineStatePatch } : {}),
        structured: {
          skillName: skill.name,
          skillPath: skill.path,
          executionMode: "inline",
          ...(request.args ? { args: request.args } : {}),
        },
      };
    }

    if (!context.toolContext?.tools?.invoke) {
      throw new Error(
        `Skill ${skill.name} requires fork execution but no nested tool invoker is available.`,
      );
    }

    const taskResult = await context.toolContext.tools.invoke({
      name: "task",
      input: {
        subagent_type: skill.subagent ?? "general-purpose",
        description: expandedPrompt,
      },
    });

    const forkStatePatch = mergeStatePatches(statePatch, taskResult.output.statePatch);
    return {
      content: taskResult.output.content,
      ...(taskResult.output.metadata ? { metadata: taskResult.output.metadata } : {}),
      ...(forkStatePatch ? { statePatch: forkStatePatch } : {}),
      structured: {
        skillName: skill.name,
        skillPath: skill.path,
        executionMode: "fork",
        ...(request.args ? { args: request.args } : {}),
        delegatedToTask: true,
        taskResult: taskResult.output.structured,
      },
    };
  }
}

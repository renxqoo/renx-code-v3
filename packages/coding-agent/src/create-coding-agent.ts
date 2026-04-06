import type { AgentTool } from "@renx/agent";
import { createDeepAgent } from "@renx/agent";
import type { ModelBinding } from "@renx/model";
import { getDefaultModelClient } from "@renx/model";

import { createBuiltInCodingSubagents, toInlineSubagents } from "./builtins";
import { DEFAULT_CODING_AGENT_SYSTEM_PROMPT } from "./prompts";
import { resolveCodingToolset } from "./tool-selection";
import type { CodingBuiltInAgentDefinition, CreateCodingAgentOptions } from "./types";
import { createCodingMemorySubsystem } from "./memory";

type SystemPromptValue = string | ((ctx: unknown) => string | Promise<string>);

const combineSystemPrompt = (
  customPrompt: SystemPromptValue | undefined,
  memorySection?: string,
): SystemPromptValue => {
  const parts: SystemPromptValue[] = [];

  if (customPrompt) {
    parts.push(customPrompt);
  }
  parts.push(DEFAULT_CODING_AGENT_SYSTEM_PROMPT);
  if (memorySection) {
    parts.push(memorySection);
  }

  if (parts.length === 1 && typeof parts[0] === "string") return parts[0];

  return (ctx: unknown) =>
    Promise.all(parts.map((p) => (typeof p === "function" ? p(ctx) : p))).then((resolved) =>
      resolved
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .join("\n\n"),
    );
};

export const getBuiltInCodingSubagents = (tools?: AgentTool[]): CodingBuiltInAgentDefinition[] =>
  createBuiltInCodingSubagents(resolveCodingToolset(tools));

export const createCodingAgent = async (options: CreateCodingAgentOptions) => {
  const resolvedTools = resolveCodingToolset(options.tools);
  const builtIns = toInlineSubagents(getBuiltInCodingSubagents(resolvedTools));

  // --- Resolve memory subsystem ---
  let memorySubsystem: import("@renx/agent").MemorySubsystem | undefined;
  let memoryPromptSection: string | undefined;
  let sessionMemory: import("@renx/agent").SessionMemorySubsystem | undefined;

  // Destructure to separate memory config from base options
  // (avoids type conflict: CreateDeepAgentOptions.memory is string[], ours is CodingAgentMemoryConfig)
  const {
    memory: memoryConfig,
    systemPrompt: customPrompt,
    tools: _tools,
    subagents: _subagents,
    ...baseOptions
  } = options;

  if (memoryConfig) {
    const rawClient = memoryConfig.modelBinding?.client ?? getDefaultModelClient();
    if (!rawClient) {
      throw new Error(
        "A model client is required when memory is enabled. Provide memory.modelBinding or configure a default model client.",
      );
    }
    const modelClient = rawClient;
    const modelName =
      memoryConfig.modelBinding?.name ??
      (typeof options.model === "string" ? options.model : options.model?.name);

    const fallbackBinding: ModelBinding = {
      client: modelClient,
      name: modelName ?? "claude-sonnet-4-6",
    };

    const memoryState = await createCodingMemorySubsystem(memoryConfig, fallbackBinding);

    memorySubsystem = memoryState.subsystem;
    memoryPromptSection = memoryState.promptSection;
    sessionMemory = memoryState.sessionMemory;

    // Attach orchestrator and services for external access via the options object.
    const stash = options as unknown as Record<string, unknown>;
    if (memoryState.orchestrator) {
      stash._memoryOrchestrator = memoryState.orchestrator;
    }
    stash._memoryService = memoryState.memoryService;
    stash._memoryCommandService = memoryState.commandService;
  }

  // Check for direct memorySubsystem on the raw options (escape hatch for pre-built subsystems)
  const directSubsystem = (options as unknown as Record<string, unknown>).memorySubsystem;
  if (!memorySubsystem && directSubsystem) {
    memorySubsystem = directSubsystem as import("@renx/agent").MemorySubsystem;
  }

  return createDeepAgent({
    ...baseOptions,
    systemPrompt: combineSystemPrompt(
      typeof customPrompt === "function"
        ? (ctx: unknown) => customPrompt(ctx as Parameters<typeof customPrompt>[0])
        : customPrompt,
      memoryPromptSection,
    ),
    tools: resolvedTools,
    subagents: [...builtIns, ...(options.subagents ?? [])],
    ...(memorySubsystem ? { memorySubsystem } : {}),
    ...(sessionMemory ? { sessionMemory } : {}),
  });
};

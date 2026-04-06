import { generateId } from "../helpers";
import type { RunMessage } from "../message/types";
import type { AgentRunContext, AgentStatePatch } from "../types";

import { DefaultSkillExecutor } from "./executor";
import { InMemorySkillRegistry } from "./registry";
import { buildSkillsStatePatch, getSkillsRuntimeState } from "./state";
import type {
  SkillDefinition,
  SkillDiscoveryRequest,
  SkillExecutionRequest,
  SkillInvocationRecord,
  SkillsConfig,
  SkillsService,
  SkillsSubsystem,
} from "./types";

const DEFAULT_SKILLS_CONFIG: SkillsConfig = {
  includeAvailableListing: true,
  includeRelevantSkills: true,
  includeInvokedSummary: true,
  maxAvailableSkills: 8,
  maxRelevantSkills: 3,
  maxInvokedSkills: 5,
};

const getLastUserQuery = (messages: RunMessage[]): string | undefined =>
  [...messages].reverse().find((message) => message.role === "user")?.content;

export class DefaultSkillsService implements SkillsService {
  private readonly executor = new DefaultSkillExecutor();
  private readonly config: SkillsConfig;

  constructor(private readonly subsystem: SkillsSubsystem) {
    this.config = {
      ...DEFAULT_SKILLS_CONFIG,
      ...(subsystem.config ?? {}),
    };
  }

  list(): SkillDefinition[] {
    return this.subsystem.registry.list();
  }

  discover(request: SkillDiscoveryRequest) {
    const result = this.subsystem.registry.discover({
      ...request,
      limit: request.limit ?? this.config.maxRelevantSkills,
    });
    void this.subsystem.hooks?.onSkillsDiscovered?.(result);
    return result;
  }

  buildPromptMessages(runContext: AgentRunContext, messages: RunMessage[]): RunMessage[] {
    const sections: string[] = [];
    const available = this.list();
    const runtimeState = getSkillsRuntimeState(runContext.state.scratchpad);
    const query = getLastUserQuery(messages);
    const relevant =
      query && this.config.includeRelevantSkills
        ? this.discover({ query, limit: this.config.maxRelevantSkills }).matches
        : [];

    if (relevant.length > 0) {
      sections.push(
        [
          "Relevant skills:",
          ...relevant.map((skill) => `- ${skill.name}: ${skill.description}`),
        ].join("\n"),
      );
    }

    if (this.config.includeAvailableListing && available.length > 0) {
      sections.push(
        [
          "Available skills:",
          ...available
            .slice(0, this.config.maxAvailableSkills)
            .map((skill) => `- ${skill.name}: ${skill.description}`),
        ].join("\n"),
      );
    }

    if (this.config.includeInvokedSummary && runtimeState.invoked.length > 0) {
      sections.push(
        [
          "Previously invoked skills:",
          ...runtimeState.invoked
            .slice(-this.config.maxInvokedSkills)
            .map(
              (entry) =>
                `- ${entry.skillName}${entry.args ? ` (${entry.args})` : ""} [${entry.executionMode}]`,
            ),
        ].join("\n"),
      );
    }

    if (sections.length === 0) return [];
    return [
      {
        id: generateId(),
        messageId: generateId("msg"),
        role: "system",
        content: `[Skills]\n${sections.join("\n\n")}`,
        createdAt: new Date().toISOString(),
        source: "framework",
      },
    ];
  }

  createInvocationStatePatch(
    runContext: AgentRunContext,
    record: SkillInvocationRecord,
  ): AgentStatePatch {
    return buildSkillsStatePatch(runContext.state.scratchpad, record);
  }

  async invoke(
    request: SkillExecutionRequest,
    context: {
      runContext: AgentRunContext;
      toolContext?: Parameters<DefaultSkillExecutor["execute"]>[2]["toolContext"];
    },
  ) {
    const skill = this.subsystem.registry.resolve(request.skill);
    if (!skill) {
      throw new Error(`Skill not found: ${request.skill}`);
    }
    const result = await this.executor.execute(skill, request, {
      runContext: context.runContext,
      ...(context.toolContext ? { toolContext: context.toolContext } : {}),
    });
    void this.subsystem.hooks?.onSkillInvoked?.(
      {
        skillName: skill.name,
        skillPath: skill.path,
        executionMode: skill.executionMode,
        invokedAt: new Date().toISOString(),
        ...(request.args ? { args: request.args } : {}),
      },
      skill,
    );
    return result;
  }
}

export const createSkillsSubsystem = (input: {
  skills: SkillDefinition[];
  config?: Partial<SkillsConfig>;
  hooks?: SkillsSubsystem["hooks"];
}): SkillsSubsystem => ({
  registry: new InMemorySkillRegistry(input.skills),
  ...(input.config ? { config: input.config } : {}),
  ...(input.hooks ? { hooks: input.hooks } : {}),
});

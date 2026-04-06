import type { AgentTool, SkillsSubsystem } from "@renx/agent";
import { createToolCapabilityProfile, DefaultSkillsService } from "@renx/agent";
import { z } from "zod";

import { buildPlatformPatch, getSkillsCatalog, getToolCatalog, okToolResult } from "./shared";

const TOOL_SEARCH_PROMPT = `Fetches full schema definitions for deferred tools so they can be called.

Deferred tools appear by name in <system-reminder> messages. Until fetched, only the name is known - there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions.

Query forms:
- "select:Read,Edit,Grep" - fetch these exact tools by name
- "notebook jupyter" - keyword search, up to max_results best matches
- "+slack send" - require "slack" in the name, rank by remaining terms`;

const SKILL_TOOL_PROMPT = `Execute a skill within the main conversation

When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.

When users reference a "slash command" or "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke it.

How to invoke:
- Use this tool with the skill name and optional arguments
- Examples:
  - \`skill: "pdf"\` - invoke the pdf skill
  - \`skill: "commit", args: "-m 'Fix bug'"\` - invoke with arguments
  - \`skill: "review-pr", args: "123"\` - invoke with arguments
  - \`skill: "ms-office-suite:pdf"\` - invoke using fully qualified name

Important:
- Available skills are listed in system-reminder messages in the conversation
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)`;

const DISCOVER_SKILLS_PROMPT = `Discover relevant skills for the current task.

Use this when you need to find which available skills best match the user's request before invoking Skill.

Inputs:
- query: the task or intent to match against skill names, descriptions, aliases, and keywords
- touched_paths: optional paths already being worked on to improve matching
- max_results: optional cap for returned matches`;

const requireSkillsSubsystem = (subsystem: SkillsSubsystem | undefined): DefaultSkillsService => {
  if (!subsystem) {
    throw new Error("Skills subsystem is not configured for this run.");
  }
  return new DefaultSkillsService(subsystem);
};

const discoverCatalogSkills = (
  query: string,
  limit: number | undefined,
  ctx: Parameters<typeof getSkillsCatalog>[0],
) => {
  const normalized = query.toLowerCase();
  return getSkillsCatalog(ctx)
    .filter(
      (skill) =>
        skill.name.toLowerCase().includes(normalized) ||
        skill.description?.toLowerCase().includes(normalized),
    )
    .slice(0, limit ?? 5);
};

export const createToolSearchTool = (): AgentTool => {
  const schema = z.object({
    query: z.string().min(1),
    max_results: z.number().int().positive().optional(),
  });
  return {
    name: "ToolSearch",
    description: TOOL_SEARCH_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["search", "tooling"],
      sandboxExpectation: "read-only",
      auditCategory: "search",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      const query = parsed.query.toLowerCase();
      const matches = getToolCatalog(ctx).filter(
        (entry) =>
          entry.name.toLowerCase().includes(query) ||
          entry.description?.toLowerCase().includes(query),
      );
      const limited = matches.slice(0, parsed.max_results ?? 5);
      return okToolResult(
        limited.map((entry) => `${entry.name}: ${entry.description ?? ""}`.trim()).join("\n"),
        {
          structured: {
            matches: limited.map((entry) => entry.name),
            query: parsed.query,
            total_deferred_tools: matches.length,
          },
        },
      );
    },
  };
};

export const createSkillTool = (): AgentTool => {
  const schema = z.object({
    skill: z.string().min(1),
    args: z.string().optional(),
  });
  return {
    name: "Skill",
    description: SKILL_TOOL_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["skills"],
      sandboxExpectation: "read-only",
      auditCategory: "skills",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      const subsystem = ctx.runContext.services.skills;
      if (!subsystem) {
        const catalogMatch = getSkillsCatalog(ctx).find((skill) => skill.name === parsed.skill);
        if (!catalogMatch) {
          throw new Error(`Skill not found: ${parsed.skill}`);
        }
        return okToolResult(`Launching skill: ${catalogMatch.name}`, {
          structured: {
            skillName: catalogMatch.name,
            executionMode: "catalog",
            ...(catalogMatch.path ? { path: catalogMatch.path } : {}),
          },
          statePatch: buildPlatformPatch(ctx, (state) => ({
            ...state,
            activatedSkills: state.activatedSkills.includes(catalogMatch.name)
              ? state.activatedSkills
              : [...state.activatedSkills, catalogMatch.name],
          })),
        });
      }
      return await requireSkillsSubsystem(ctx.runContext.services.skills).invoke(
        {
          skill: parsed.skill,
          ...(parsed.args !== undefined ? { args: parsed.args } : {}),
        },
        {
          runContext: ctx.runContext,
          toolContext: ctx,
        },
      );
    },
  };
};

export const createDiscoverSkillsTool = (): AgentTool => {
  const schema = z.object({
    query: z.string().min(1),
    touched_paths: z.array(z.string().min(1)).optional(),
    max_results: z.number().int().positive().optional(),
  });
  return {
    name: "DiscoverSkills",
    description: DISCOVER_SKILLS_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["skills", "search"],
      sandboxExpectation: "read-only",
      auditCategory: "skills",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      const matches = ctx.runContext.services.skills
        ? requireSkillsSubsystem(ctx.runContext.services.skills).discover({
            query: parsed.query,
            ...(parsed.touched_paths ? { touchedPaths: parsed.touched_paths } : {}),
            ...(parsed.max_results ? { limit: parsed.max_results } : {}),
          }).matches
        : discoverCatalogSkills(parsed.query, parsed.max_results, ctx);
      return okToolResult(
        matches.map((skill) => `${skill.name}: ${skill.description}`).join("\n"),
        {
          structured: {
            query: parsed.query,
            matches: matches.map((skill) => skill.name),
          },
        },
      );
    },
  };
};

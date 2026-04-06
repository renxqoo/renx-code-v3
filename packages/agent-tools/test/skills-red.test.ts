import { describe, expect, it } from "vitest";

import type { AgentRunContext, ToolContext } from "@renx/agent";
import type { ToolCall } from "@renx/model";

import { createDiscoverSkillsTool, createSkillTool } from "../src";
import { createSkillsSubsystem, DefaultSkillsService } from "@renx/agent";

const createRunContext = (): AgentRunContext => ({
  input: { messages: [] },
  identity: { userId: "u1", tenantId: "t1", roles: [] },
  state: {
    runId: "run_1",
    messages: [],
    scratchpad: {},
    memory: {},
    stepCount: 0,
    status: "running",
  },
  services: {
    skills: createSkillsSubsystem({
      skills: [
        {
          name: "commit",
          description: "Create a clean git commit",
          prompt: "Commit the staged diff.\nArgs: $ARGUMENTS",
          path: ".skills/commit/SKILL.md",
          source: "project",
          tags: ["git"],
          aliases: ["git-commit"],
          keywords: ["commit", "git", "staged"],
          userInvocable: true,
          executionMode: "inline",
        },
        {
          name: "review-pr",
          description: "Review the current pull request",
          prompt: "Review the current PR thoroughly.",
          path: ".skills/review-pr/SKILL.md",
          source: "project",
          tags: ["review"],
          aliases: [],
          keywords: ["review", "pr"],
          userInvocable: true,
          executionMode: "fork",
        },
      ],
    }),
  },
  metadata: {},
});

const createToolContext = (): ToolContext => {
  const runContext = createRunContext();
  const toolCall: ToolCall = {
    id: "tc_1",
    name: "Skill",
    input: {},
  };
  return {
    runContext,
    toolCall,
    backend: undefined,
    tools: {
      list: () => [],
      get: (name) => (name === "task" ? ({ name } as never) : undefined),
      invoke: async (request) => ({
        tool: { name: request.name, description: "", invoke: async () => ({ content: "" }) },
        call: {
          id: request.id ?? "nested",
          name: request.name,
          input: request.input,
        },
        output: {
          content: "forked skill completed",
          structured: request.input,
        },
      }),
    },
  };
};

describe("skill tools", () => {
  it("discovers relevant skills through the core skills subsystem", async () => {
    const tool = createDiscoverSkillsTool();
    const result = await tool.invoke(
      {
        query: "commit staged changes",
      },
      createToolContext(),
    );

    expect(result.content).toContain("commit");
    expect(result.structured).toMatchObject({
      matches: ["commit"],
    });
  });

  it("executes inline skills through the core skills subsystem instead of a demo patch", async () => {
    const tool = createSkillTool();
    const ctx = createToolContext();

    const result = await tool.invoke(
      {
        skill: "commit",
        args: "feat: ship enterprise skills",
      },
      ctx,
    );

    expect(result.statePatch?.appendMessages?.[0]?.content).toContain(
      "feat: ship enterprise skills",
    );
    expect(result.structured).toMatchObject({
      skillName: "commit",
      executionMode: "inline",
    });
  });

  it("dispatches fork skills through nested task execution when the skill requires fork mode", async () => {
    const tool = createSkillTool();
    const ctx = createToolContext();

    const result = await tool.invoke(
      {
        skill: "review-pr",
        args: "123",
      },
      ctx,
    );

    expect(result.content).toContain("forked skill completed");
    expect(result.structured).toMatchObject({
      skillName: "review-pr",
      executionMode: "fork",
    });
  });
});

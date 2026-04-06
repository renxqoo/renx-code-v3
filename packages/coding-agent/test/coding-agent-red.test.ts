import { describe, expect, it } from "vitest";

import {
  clearDefaultModelClient,
  setDefaultModelClient,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from "@renx/model";

import { createCodingAgent, getBuiltInCodingSubagents } from "../src";
import { buildInput } from "../../agent/test/helpers";

const createCapturingModelClient = (
  captured: ModelRequest[],
  responses?: ModelResponse[],
): ModelClient => {
  let index = 0;
  return {
    generate: async (request) => {
      captured.push(request);
      return responses?.[index++] ?? { type: "final", output: "ok" };
    },
    stream: async function* () {
      yield { type: "done" as const };
    },
    resolve: (model) => ({
      logicalModel: model,
      provider: "test",
      providerModel: model,
    }),
  };
};

describe("coding-agent", () => {
  it("exposes Claude-style built-in specialist agents", () => {
    const builtIns = getBuiltInCodingSubagents();

    expect(builtIns.map((agent) => agent.name)).toEqual([
      "general-purpose",
      "Explore",
      "Plan",
      "verification",
    ]);
  });

  it("creates a coding-focused deep agent with the default coding toolset and task delegation", async () => {
    const captured: ModelRequest[] = [];
    setDefaultModelClient(createCapturingModelClient(captured));

    const agent = createCodingAgent({
      model: "gpt-5.4",
    });

    await agent.invoke(buildInput({ inputText: "inspect the repo and fix the bug" }));
    clearDefaultModelClient();

    expect(captured[0]?.systemPrompt).toContain("Complete the task fully");
    expect(captured[0]?.systemPrompt).toContain("Read relevant context before acting");
    expect(captured[0]?.tools.map((tool) => tool.name)).toEqual([
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "git_status",
      "run_checks",
      "Bash",
      "task",
    ]);
  });

  it("delegates to the Explore specialist with read-only tools and the exploration prompt", async () => {
    const captured: ModelRequest[] = [];
    setDefaultModelClient(
      createCapturingModelClient(captured, [
        {
          type: "tool_calls",
          toolCalls: [
            {
              id: "tc_task_1",
              name: "task",
              input: {
                subagent_type: "Explore",
                description: "Locate the primary API router implementation.",
              },
            },
          ],
        },
        { type: "final", output: "Explore result" },
        { type: "final", output: "done" },
      ]),
    );

    const agent = createCodingAgent({
      model: "gpt-5.4",
    });

    const result = await agent.invoke(buildInput({ inputText: "find the router" }));
    clearDefaultModelClient();

    expect(result.status).toBe("completed");
    expect(captured[1]?.systemPrompt).toContain("READ-ONLY MODE - NO FILE MODIFICATIONS");
    expect(captured[1]?.systemPrompt).toContain("file search specialist");
    expect(captured[1]?.tools.map((tool) => tool.name)).toEqual([
      "Read",
      "Glob",
      "Grep",
      "git_status",
      "Bash",
    ]);
    expect(captured[1]?.messages.at(-1)?.content).toContain(
      "Locate the primary API router implementation.",
    );
  });

  it("delegates to the Plan specialist with planning-specific output guidance", async () => {
    const captured: ModelRequest[] = [];
    setDefaultModelClient(
      createCapturingModelClient(captured, [
        {
          type: "tool_calls",
          toolCalls: [
            {
              id: "tc_task_2",
              name: "task",
              input: {
                subagent_type: "Plan",
                description: "Design the implementation plan for context compaction retry.",
              },
            },
          ],
        },
        { type: "final", output: "Plan result" },
        { type: "final", output: "done" },
      ]),
    );

    const agent = createCodingAgent({
      model: "gpt-5.4",
    });

    await agent.invoke(buildInput({ inputText: "make a plan" }));
    clearDefaultModelClient();

    expect(captured[1]?.systemPrompt).toContain("software architect and planning specialist");
    expect(captured[1]?.systemPrompt).toContain("Critical Files for Implementation");
    expect(captured[1]?.tools.map((tool) => tool.name)).toEqual([
      "Read",
      "Glob",
      "Grep",
      "git_status",
      "Bash",
    ]);
  });

  it("delegates to the verification specialist with verifier semantics and no write tools", async () => {
    const captured: ModelRequest[] = [];
    setDefaultModelClient(
      createCapturingModelClient(captured, [
        {
          type: "tool_calls",
          toolCalls: [
            {
              id: "tc_task_3",
              name: "task",
              input: {
                subagent_type: "verification",
                description: "Verify the implementation thoroughly.",
              },
            },
          ],
        },
        { type: "final", output: "VERDICT: PASS" },
        { type: "final", output: "done" },
      ]),
    );

    const agent = createCodingAgent({
      model: "gpt-5.4",
    });

    await agent.invoke(buildInput({ inputText: "verify it" }));
    clearDefaultModelClient();

    expect(captured[1]?.systemPrompt).toContain(
      "Your job is not to confirm the implementation works",
    );
    expect(captured[1]?.systemPrompt).toContain("VERDICT: PASS");
    expect(captured[1]?.tools.map((tool) => tool.name)).toEqual([
      "Read",
      "Glob",
      "Grep",
      "git_status",
      "run_checks",
      "Bash",
    ]);
  });

  it("delegates to the general-purpose specialist with the full coding toolset", async () => {
    const captured: ModelRequest[] = [];
    setDefaultModelClient(
      createCapturingModelClient(captured, [
        {
          type: "tool_calls",
          toolCalls: [
            {
              id: "tc_task_4",
              name: "task",
              input: {
                subagent_type: "general-purpose",
                description: "Research the codebase and edit the implementation.",
              },
            },
          ],
        },
        { type: "final", output: "done work" },
        { type: "final", output: "done" },
      ]),
    );

    const agent = createCodingAgent({
      model: "gpt-5.4",
    });

    await agent.invoke(buildInput({ inputText: "do the work" }));
    clearDefaultModelClient();

    expect(captured[1]?.systemPrompt).toContain("respond with a concise report");
    expect(captured[1]?.tools.map((tool) => tool.name)).toEqual([
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "git_status",
      "run_checks",
      "Bash",
    ]);
  });
});

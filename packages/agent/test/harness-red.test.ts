import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, afterEach } from "vitest";
import { z } from "zod";

import {
  clearDefaultModelClient,
  setDefaultModelClient,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from "@renx/model";

import {
  LocalBackend,
  createDeepAgent,
  mergeMemorySnapshot,
  type AgentTool,
  type ToolResult,
} from "../src";
import { buildInput } from "./helpers";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  clearDefaultModelClient();
});

const createMockTool = (name: string): AgentTool => ({
  name,
  description: `${name} tool`,
  schema: z.object({}).passthrough(),
  invoke: async (input: unknown) => ({
    content: JSON.stringify(input),
  }),
});

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
    resolve: () => ({
      logicalModel: "test",
      provider: "test",
      providerModel: "test",
    }),
  };
};

describe("createDeepAgent", () => {
  it("uses messages-first input and top-level tools", async () => {
    const captured: ModelRequest[] = [];
    const agent = createDeepAgent({
      name: "deep-agent-test",
      model: {
        client: createCapturingModelClient(captured),
        name: "test-model",
      },
      systemPrompt: "You are the new deep agent.",
      tools: [createMockTool("direct_tool")],
    });

    const result = await agent.invoke(
      buildInput({
        messages: [
          {
            id: "msg_user_1",
            messageId: "msg_user_1",
            role: "user",
            content: "run the deep agent",
            createdAt: new Date().toISOString(),
            source: "input",
          },
        ],
      }),
    );

    expect(result.status).toBe("completed");
    expect(captured[0]?.systemPrompt).toContain("You are the new deep agent.");
    expect(captured[0]?.systemPrompt).toContain("You are a Deep Agent");
    expect(captured[0]?.tools.map((tool) => tool.name)).toEqual(["direct_tool"]);
    expect(captured[0]?.messages.at(-1)?.content).toBe("run the deep agent");
  });

  it("loads memory files and skill directories into prompt-visible working memory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-deep-memory-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "skills", "repo-skill"), { recursive: true });
    await writeFile(join(dir, "AGENTS.md"), "Prefer pnpm and keep functions tiny.\n", "utf8");
    await writeFile(
      join(dir, "skills", "repo-skill", "SKILL.md"),
      "# Repo Skill\nAlways run focused tests before broad suites.\n",
      "utf8",
    );

    const captured: ModelRequest[] = [];
    const agent = createDeepAgent({
      model: {
        client: createCapturingModelClient(captured),
        name: "test-model",
      },
      memory: [join(dir, "AGENTS.md")],
      skills: [join(dir, "skills")],
    });

    await agent.invoke(buildInput({ inputText: "continue coding" }));

    const memoryMessage = captured[0]?.messages.find((message) =>
      message.content.includes("[Agent Memory]"),
    );
    expect(memoryMessage?.content).toContain("Active Rules");
    expect(memoryMessage?.content).toContain("Prefer pnpm and keep functions tiny.");
    expect(memoryMessage?.content).toContain("Active Skills");
    expect(memoryMessage?.content).toContain("Always run focused tests before broad suites.");
  });

  it("passes a top-level backend into tool execution", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-deep-backend-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "note.txt"), "backend content\n", "utf8");

    const readTool: AgentTool = {
      name: "ReadNote",
      description: "Read a note from the configured backend",
      schema: z.object({}).passthrough(),
      invoke: async (_input, ctx): Promise<ToolResult> => ({
        content: await ctx.backend!.readFile!(join(dir, "note.txt")),
      }),
    };

    const agent = createDeepAgent({
      model: {
        client: createCapturingModelClient(
          [],
          [
            {
              type: "tool_calls",
              toolCalls: [{ id: "tc_1", name: "ReadNote", input: {} }],
            },
            { type: "final", output: "done" },
          ],
        ),
        name: "test-model",
      },
      backend: new LocalBackend(),
      tools: [readTool],
    });

    const result = await agent.invoke(buildInput({ inputText: "read the note" }));

    expect(result.status).toBe("completed");
    expect(result.state.lastToolResult?.content).toContain("backend content");
  });

  it("maps interruptOn into approval gating", async () => {
    const dangerTool = createMockTool("DangerousWrite");
    const agent = createDeepAgent({
      model: {
        client: createCapturingModelClient(
          [],
          [
            {
              type: "tool_calls",
              toolCalls: [{ id: "tc_1", name: "DangerousWrite", input: {} }],
            },
          ],
        ),
        name: "test-model",
      },
      tools: [dangerTool],
      interruptOn: {
        DangerousWrite: {
          reason: "writes need approval",
        },
      },
    });

    const result = await agent.invoke(buildInput({ inputText: "do the write" }));

    expect(result.status).toBe("waiting_approval");
    expect(result.state.error).toBeUndefined();
    expect(result.state.messages.at(-1)?.content).toContain("requires approval");
  });

  it("can seed current plan through initializeRunContext", async () => {
    const captured: ModelRequest[] = [];
    const agent = createDeepAgent({
      model: {
        client: createCapturingModelClient(captured),
        name: "test-model",
      },
      systemPrompt: (ctx) =>
        `Project=${String(ctx.metadata["project"])}; Plan=${String(ctx.state.memory.working?.activePlan ?? "")}`,
      initializeRunContext: async (ctx) => ({
        ...ctx,
        metadata: {
          ...ctx.metadata,
          project: "agent-sdk",
        },
        state: {
          ...ctx.state,
          memory: mergeMemorySnapshot(ctx.state.memory, {
            working: {
              activePlan: "1. write red tests",
            },
          }),
        },
      }),
    });

    const result = await agent.invoke(buildInput({ inputText: "enrich run context" }));

    expect(result.status).toBe("completed");
    expect(captured[0]?.systemPrompt).toContain("Project=agent-sdk");
    expect(captured[0]?.systemPrompt).toContain("1. write red tests");
  });

  it("resolves string models through the default model client and exposes top-level messages", async () => {
    const captured: ModelRequest[] = [];
    setDefaultModelClient(createCapturingModelClient(captured));

    const agent = createDeepAgent({
      model: "gpt-5.4",
      systemPrompt: "String model test",
    });

    const result = await agent.invoke(buildInput({ inputText: "run via default model client" }));

    expect(captured[0]?.model).toBe("gpt-5.4");
    expect(result.messages?.at(-1)?.role).toBe("assistant");
    expect(result.messages?.at(-1)?.content).toBe("ok");
  });

  it("accepts backend factories with state and store access", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-deep-backend-factory-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "note.txt"), "factory backend content\n", "utf8");

    let observedRunId: string | undefined;
    let observedStore: { kind: string } | undefined;
    const readTool: AgentTool = {
      name: "ReadFactoryNote",
      description: "Read a note from a backend created by factory",
      schema: z.object({}).passthrough(),
      invoke: async (_input, ctx): Promise<ToolResult> => ({
        content: await ctx.backend!.readFile!(join(dir, "note.txt")),
      }),
    };

    const agent = createDeepAgent({
      model: {
        client: createCapturingModelClient(
          [],
          [
            {
              type: "tool_calls",
              toolCalls: [{ id: "tc_factory_1", name: "ReadFactoryNote", input: {} }],
            },
            { type: "final", output: "done" },
          ],
        ),
        name: "test-model",
      },
      store: { kind: "tool-store" },
      backend: ({ state, store }) => {
        observedRunId = (state as { runId?: string }).runId;
        observedStore = store as { kind: string } | undefined;
        return new LocalBackend();
      },
      tools: [readTool],
    });

    const result = await agent.invoke(buildInput({ inputText: "read through backend factory" }));

    expect(result.status).toBe("completed");
    expect(result.state.lastToolResult?.content).toContain("factory backend content");
    expect(observedRunId).toBe(result.runId);
    expect(observedStore).toEqual({ kind: "tool-store" });
  });

  it("adds a task tool and delegates work to configured subagents", async () => {
    const childRequests: ModelRequest[] = [];
    const researcher = createDeepAgent({
      model: {
        client: createCapturingModelClient(childRequests, [
          { type: "final", output: "isolated report" },
        ]),
        name: "child-model",
      },
      systemPrompt: "You are a researcher.",
    });

    const parentRequests: ModelRequest[] = [];
    const parent = createDeepAgent({
      model: {
        client: createCapturingModelClient(parentRequests, [
          {
            type: "tool_calls",
            toolCalls: [
              {
                id: "tc_task_1",
                name: "task",
                input: {
                  description: "Investigate the bug and return a concise report",
                  subagent_type: "researcher",
                },
              },
            ],
          },
          { type: "final", output: "delegation complete" },
        ]),
        name: "parent-model",
      },
      subagents: [
        {
          name: "researcher",
          description: "Research complex engineering problems",
          runnable: researcher,
        },
      ],
    });

    const result = await parent.invoke(buildInput({ inputText: "delegate this task" }), {
      recursionLimit: 4,
    });

    expect(parentRequests[0]?.tools.map((tool) => tool.name)).toContain("task");
    expect(childRequests[0]?.messages.at(-1)?.content).toBe(
      "Investigate the bug and return a concise report",
    );
    expect(result.state.lastToolResult?.content).toContain("isolated report");
  });

  it("supports responseFormat and returns structuredResponse", async () => {
    const captured: ModelRequest[] = [];
    const agent = createDeepAgent({
      model: {
        client: createCapturingModelClient(captured, [
          {
            type: "tool_calls",
            toolCalls: [
              {
                id: "tc_structured_1",
                name: "StructuredOutput",
                input: {
                  verdict: "pass",
                  score: 100,
                },
              },
            ],
          },
          { type: "final", output: "done" },
        ]),
        name: "test-model",
      },
      responseFormat: z.object({
        verdict: z.string(),
        score: z.number().int(),
      }),
    });

    const result = await agent.invoke(buildInput({ inputText: "return structured output" }));

    expect(captured[0]?.tools.map((tool) => tool.name)).toContain("StructuredOutput");
    expect(captured[0]?.systemPrompt).toContain("You MUST call this tool exactly once");
    expect(result.structuredResponse).toEqual({
      verdict: "pass",
      score: 100,
    });
  });

  it("validates input.context with contextSchema before invocation", async () => {
    const captured: ModelRequest[] = [];
    const agent = createDeepAgent({
      model: {
        client: createCapturingModelClient(captured),
        name: "test-model",
      },
      systemPrompt: (ctx) => `Repo=${String((ctx.input.context as { repo: string }).repo)}`,
      contextSchema: z.object({
        repo: z.string(),
      }),
    });

    await agent.invoke({
      messages: [
        {
          id: "msg_ctx_1",
          messageId: "msg_ctx_1",
          role: "user",
          content: "use request context",
          createdAt: new Date().toISOString(),
          source: "input",
        },
      ],
      context: {
        repo: "renx-code-v3",
      },
    });

    expect(captured[0]?.systemPrompt).toContain("Repo=renx-code-v3");

    await expect(
      agent.invoke({
        messages: [
          {
            id: "msg_ctx_2",
            messageId: "msg_ctx_2",
            role: "user",
            content: "invalid context",
            createdAt: new Date().toISOString(),
            source: "input",
          },
        ],
        context: {
          repo: 123,
        },
      }),
    ).rejects.toThrow(/context/i);
  });

  it("maps invoke recursionLimit overrides onto runtime step limits", async () => {
    const echoTool: AgentTool = {
      name: "EchoOnce",
      description: "Echo the provided value",
      schema: z.object({
        value: z.string(),
      }),
      invoke: async (input) => ({
        content: JSON.stringify(input),
      }),
    };

    const agent = createDeepAgent({
      model: {
        client: createCapturingModelClient(
          [],
          [
            {
              type: "tool_calls",
              toolCalls: [{ id: "tc_step_1", name: "EchoOnce", input: { value: "one" } }],
            },
            { type: "final", output: "done" },
          ],
        ),
        name: "test-model",
      },
      maxSteps: 1,
      tools: [echoTool],
    });

    const result = await agent.invoke(buildInput({ inputText: "needs two steps" }), {
      recursionLimit: 4,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("done");
  });
});

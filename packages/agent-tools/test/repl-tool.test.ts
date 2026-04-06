import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AgentRunContext, AgentTool, ToolResult } from "@renx/agent";
import {
  InMemoryToolRegistry,
  MiddlewarePipeline,
  ToolExecutor,
  applyStatePatch,
} from "@renx/agent";
import type { ToolCall } from "@renx/model";

import { createReplTool } from "../src/index";

const createRunContext = (): AgentRunContext => ({
  input: {
    messages: [
      {
        id: "msg_repl_1",
        messageId: "msg_repl_1",
        role: "user",
        content: "repl test",
        createdAt: new Date().toISOString(),
        source: "input",
      },
    ],
  },
  identity: { userId: "u1", tenantId: "t1", roles: ["developer"] },
  state: {
    runId: "run_1",
    messages: [],
    scratchpad: {},
    memory: {},
    stepCount: 0,
    status: "running",
  },
  services: {},
  metadata: {},
});

describe("REPL primitive orchestration", () => {
  it("can orchestrate primitive tools through the internal tool subsystem", async () => {
    const registry = new InMemoryToolRegistry();
    const readTool: AgentTool = {
      name: "Read",
      description: "Read a file",
      schema: z.object({ file_path: z.string() }),
      invoke: async (input): Promise<ToolResult> => {
        const parsed = z.object({ file_path: z.string() }).parse(input);
        return {
          content: `read:${parsed.file_path}`,
          structured: { file_path: parsed.file_path },
        };
      },
    };
    const writeTool: AgentTool = {
      name: "Write",
      description: "Write a file",
      schema: z.object({ file_path: z.string(), content: z.string() }),
      invoke: async (input): Promise<ToolResult> => {
        const parsed = z.object({ file_path: z.string(), content: z.string() }).parse(input);
        return {
          content: `wrote:${parsed.file_path}`,
          structured: parsed,
          statePatch: {
            mergeMemory: {
              repl_write: parsed.file_path,
            },
          },
        };
      },
    };

    registry.register(readTool);
    registry.register(writeTool);
    registry.register(createReplTool());

    const executor = new ToolExecutor(registry, new MiddlewarePipeline());
    const call: ToolCall = {
      id: "tc_repl_1",
      name: "REPL",
      input: {
        language: "javascript",
        code: `
const read = await callTool("Read", { file_path: "/workspace/demo.ts" });
const write = await callTool("Write", {
  file_path: "/workspace/demo.ts",
  content: read.content,
});
return {
  read: read.content,
  write: write.content,
  primitiveTools,
};
`,
      },
    };

    const result = await executor.run(call, createRunContext());
    if (result.type !== "completed") {
      throw new Error("Expected completed result");
    }

    expect(result.result.output.structured).toMatchObject({
      result: {
        read: "read:/workspace/demo.ts",
        write: "wrote:/workspace/demo.ts",
        primitiveTools: expect.arrayContaining([
          "Read",
          "Write",
          "Edit",
          "Glob",
          "Grep",
          "Bash",
          "NotebookEdit",
          "Agent",
        ]),
      },
      toolCalls: [{ name: "Read" }, { name: "Write" }],
    });
    expect(result.result.output.statePatch).toMatchObject({
      mergeMemory: {
        repl_write: "/workspace/demo.ts",
      },
    });
  });

  it("rejects non-primitive tool access from the REPL", async () => {
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "Danger",
      description: "Should not be callable from REPL",
      schema: z.object({ value: z.string() }),
      invoke: async (): Promise<ToolResult> => ({ content: "danger" }),
    });
    registry.register(createReplTool());

    const executor = new ToolExecutor(registry, new MiddlewarePipeline());
    const call: ToolCall = {
      id: "tc_repl_2",
      name: "REPL",
      input: {
        language: "javascript",
        code: `await callTool("Danger", { value: "x" });`,
      },
    };

    const result = await executor.run(call, createRunContext());
    if (result.type !== "completed") {
      throw new Error("Expected completed result");
    }

    expect(result.result.output.metadata?.errorCode).toBe("TOOL_ERROR");
    expect(result.result.output.content).toContain("REPL can only invoke primitive tools");
  });

  it("does not emit stale aggregate patches when the REPL body makes no state changes", async () => {
    const registry = new InMemoryToolRegistry();
    registry.register(createReplTool());

    const ctx = createRunContext();
    ctx.state = {
      ...ctx.state,
      scratchpad: { shared: "before" },
      memory: { shared: "before" },
    };

    const executor = new ToolExecutor(
      registry,
      new MiddlewarePipeline([
        {
          name: "after-tool-mw",
          afterTool: () => ({
            statePatch: {
              setScratchpad: { shared: "after" },
              mergeMemory: { shared: "after" },
            },
          }),
        },
      ]),
    );

    const result = await executor.run(
      {
        id: "tc_repl_noop",
        name: "REPL",
        input: {
          language: "javascript",
          code: `return "ok";`,
        },
      },
      ctx,
    );

    if (result.type !== "completed") {
      throw new Error("Expected completed result");
    }

    let nextState = ctx.state;
    for (const patch of result.statePatches) {
      nextState = applyStatePatch(nextState, patch);
    }
    nextState = applyStatePatch(nextState, result.result.output.statePatch);

    expect(result.result.output.statePatch).toBeUndefined();
    expect(nextState.scratchpad).toMatchObject({ shared: "after" });
    expect(nextState.memory).toMatchObject({ shared: "after" });
  });
});

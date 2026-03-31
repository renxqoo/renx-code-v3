import { describe, expect, it } from "vitest";

import type { ToolCall } from "@renx/model";

import { ToolExecutor } from "../../src/tool/executor";
import { InMemoryToolRegistry } from "../../src/tool/registry";
import type { AgentTool, ToolResult } from "../../src/tool/types";
import { MiddlewarePipeline } from "../../src/middleware/pipeline";
import { baseCtx } from "../helpers";

const echoTool: AgentTool = {
  name: "echo",
  description: "Echoes input",
  invoke: async (input: unknown): Promise<ToolResult> => ({
    content: JSON.stringify(input),
  }),
};

const failTool: AgentTool = {
  name: "fail",
  description: "Always fails",
  invoke: async (): Promise<ToolResult> => {
    throw new Error("Tool failed");
  },
};

const call: ToolCall = {
  id: "tc_1",
  name: "echo",
  input: { message: "hello" },
};

describe("ToolExecutor", () => {
  it("executes a tool and returns result", async () => {
    const registry = new InMemoryToolRegistry();
    registry.register(echoTool);

    const executor = new ToolExecutor(registry, new MiddlewarePipeline());
    const result = await executor.run(call, baseCtx());

    if (result.type !== "completed") {
      throw new Error("Expected completed result");
    }

    expect(result.result.tool.name).toBe("echo");
    expect(result.result.call.id).toBe("tc_1");
    expect(result.result.output.content).toBe('{"message":"hello"}');
    expect(result.shouldStop).toBe(false);
  });

  it("throws for unknown tool", async () => {
    const registry = new InMemoryToolRegistry();
    const executor = new ToolExecutor(registry, new MiddlewarePipeline());

    await expect(executor.run(call, baseCtx())).rejects.toThrow("Tool not found: echo");
  });

  it("propagates tool execution errors", async () => {
    const registry = new InMemoryToolRegistry();
    registry.register(failTool);

    const executor = new ToolExecutor(registry, new MiddlewarePipeline());
    const failCall: ToolCall = { id: "tc_2", name: "fail", input: {} };

    await expect(executor.run(failCall, baseCtx())).rejects.toThrow("Tool failed");
  });

  it("stops when middleware signals stopCurrentStep", async () => {
    const registry = new InMemoryToolRegistry();
    registry.register(echoTool);

    const pipeline = new MiddlewarePipeline([
      {
        name: "stop-mw",
        beforeTool: () => ({ stopCurrentStep: true }),
      },
    ]);

    const executor = new ToolExecutor(registry, pipeline);
    const result = await executor.run(call, baseCtx());

    expect(result.type).toBe("stopped");
    if (result.type === "stopped") {
      expect(result.reason).toBe("middleware_stop");
      expect(result.tool.name).toBe("echo");
    }
  });

  it("applies state patches from middleware via return value", async () => {
    const registry = new InMemoryToolRegistry();
    registry.register(echoTool);

    const pipeline = new MiddlewarePipeline([
      {
        name: "patch-mw",
        beforeTool: () => ({
          statePatch: { mergeMemory: { injected: true } },
        }),
      },
    ]);

    const executor = new ToolExecutor(registry, pipeline);
    const ctx = baseCtx();
    const result = await executor.run(call, ctx);

    // Executor should NOT mutate ctx directly — patches come via return value
    expect(ctx.state.memory).toEqual({});

    if (result.type === "completed") {
      expect(result.statePatches).toHaveLength(1);
      expect(result.statePatches[0]).toEqual({ mergeMemory: { injected: true } });
    }
  });

  it("afterTool middleware returns decision (statePatch + shouldStop)", async () => {
    const registry = new InMemoryToolRegistry();
    registry.register(echoTool);

    const pipeline = new MiddlewarePipeline([
      {
        name: "after-stop-mw",
        afterTool: () => ({
          statePatch: { mergeMemory: { afterTool: true } },
          stopCurrentStep: true,
        }),
      },
    ]);

    const executor = new ToolExecutor(registry, pipeline);
    const result = await executor.run(call, baseCtx());

    if (result.type !== "completed") {
      throw new Error("Expected completed result");
    }

    expect(result.shouldStop).toBe(true);
    expect(result.statePatches).toHaveLength(1);
    expect(result.statePatches[0]).toEqual({ mergeMemory: { afterTool: true } });
  });

  it("BackendResolver is called and backend is passed to tool", async () => {
    let capturedBackend: unknown;
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "echo",
      description: "Echoes input",
      invoke: async (input: unknown, ctx): Promise<ToolResult> => {
        capturedBackend = ctx.backend;
        return { content: JSON.stringify(input) };
      },
    });

    const mockBackend = { kind: "test-backend" };
    const resolver = {
      resolve: async () =>
        mockBackend as unknown as import("../../src/tool/types").ExecutionBackend,
    };

    const executor = new ToolExecutor(registry, new MiddlewarePipeline(), resolver);
    const result = await executor.run(call, baseCtx());

    if (result.type !== "completed") {
      throw new Error("Expected completed result");
    }

    expect(capturedBackend).toBe(mockBackend);
  });

  it("ToolContext has correct fields (runContext, toolCall, backend)", async () => {
    let capturedCtx: unknown;
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "echo",
      description: "Echoes input",
      invoke: async (_input: unknown, ctx): Promise<ToolResult> => {
        capturedCtx = ctx;
        return { content: "ok" };
      },
    });

    const executor = new ToolExecutor(registry, new MiddlewarePipeline());
    const runCtx = baseCtx();
    const result = await executor.run(call, runCtx);

    if (result.type !== "completed") {
      throw new Error("Expected completed result");
    }

    const toolCtx = capturedCtx as { runContext: unknown; toolCall: unknown; backend: unknown };
    expect(toolCtx.runContext).toBe(runCtx);
    expect(toolCtx.toolCall).toBe(call);
    expect(toolCtx.backend).toBeUndefined();
  });
});

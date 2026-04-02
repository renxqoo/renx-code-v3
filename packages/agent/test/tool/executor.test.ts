import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ToolCall } from "@renx/model";

import { AgentError } from "../../src/errors";
import { ToolExecutor } from "../../src/tool/executor";
import { InMemoryToolRegistry } from "../../src/tool/registry";
import type { AgentTool, ToolResult } from "../../src/tool/types";
import { MiddlewarePipeline } from "../../src/middleware/pipeline";
import { baseCtx } from "../helpers";

const echoTool: AgentTool = {
  name: "echo",
  description: "Echoes input",
  schema: z.object({}).passthrough(),
  invoke: async (input: unknown): Promise<ToolResult> => ({
    content: JSON.stringify(input),
  }),
};

const safeTool: AgentTool = {
  name: "safe-echo",
  description: "Concurrency-safe echo",
  schema: z.object({}).passthrough(),
  invoke: async (input: unknown): Promise<ToolResult> => ({
    content: JSON.stringify(input),
  }),
  isConcurrencySafe: () => true,
};

const failTool: AgentTool = {
  name: "fail",
  description: "Always fails",
  schema: z.object({}).passthrough(),
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

  it("throws validation error for invalid input", async () => {
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "strict-echo",
      description: "Requires message field",
      schema: z.object({ message: z.string() }),
      invoke: async (input: unknown): Promise<ToolResult> => ({
        content: JSON.stringify(input),
      }),
    });

    const executor = new ToolExecutor(registry, new MiddlewarePipeline());
    const invalidCall: ToolCall = { id: "tc_invalid", name: "strict-echo", input: { bad: true } };

    await expect(executor.run(invalidCall, baseCtx())).rejects.toThrow(
      'Invalid input for tool "strict-echo"',
    );
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

  it("runs middleware onError and emits tool_failed audit on tool error", async () => {
    const registry = new InMemoryToolRegistry();
    registry.register(failTool);

    let onErrorCalled = false;
    const events: string[] = [];
    const pipeline = new MiddlewarePipeline([
      {
        name: "error-mw",
        onError: () => {
          onErrorCalled = true;
        },
      },
    ]);

    const executor = new ToolExecutor(registry, pipeline);
    const failCall: ToolCall = { id: "tc_2", name: "fail", input: {} };
    const ctx = baseCtx();
    ctx.services.audit = {
      log: (event) => {
        events.push(event.type);
      },
    };

    await expect(executor.run(failCall, ctx)).rejects.toThrow("Tool failed");
    expect(onErrorCalled).toBe(true);
    expect(events).toContain("tool_failed");
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
      schema: z.object({}).passthrough(),
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
      schema: z.object({}).passthrough(),
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

  describe("runBatch", () => {
    it("executes multiple tool calls", async () => {
      const registry = new InMemoryToolRegistry();
      registry.register(echoTool);

      const calls: ToolCall[] = [
        { id: "tc_1", name: "echo", input: { a: 1 } },
        { id: "tc_2", name: "echo", input: { b: 2 } },
      ];

      const executor = new ToolExecutor(registry, new MiddlewarePipeline());
      const results = await executor.runBatch(calls, baseCtx());

      expect(results).toHaveLength(2);
      expect(results[0]!.call.id).toBe("tc_1");
      expect(results[0]!.result.output.content).toBe('{"a":1}');
      expect(results[1]!.call.id).toBe("tc_2");
      expect(results[1]!.result.output.content).toBe('{"b":2}');
    });

    it("runs concurrency-safe tools in parallel", async () => {
      const registry = new InMemoryToolRegistry();
      registry.register(safeTool);

      const executionOrder: string[] = [];

      const trackingTool: AgentTool = {
        name: "safe-echo",
        description: "Concurrency-safe echo",
        schema: z.object({ id: z.string() }),
        invoke: async (input: unknown): Promise<ToolResult> => {
          const callInput = input as { id: string };
          executionOrder.push(`start:${callInput.id}`);
          await new Promise((r) => setTimeout(r, 10));
          executionOrder.push(`end:${callInput.id}`);
          return { content: JSON.stringify(input) };
        },
        isConcurrencySafe: () => true,
      };

      const trackingRegistry = new InMemoryToolRegistry();
      trackingRegistry.register(trackingTool);

      const calls: ToolCall[] = [
        { id: "tc_1", name: "safe-echo", input: { id: "a" } },
        { id: "tc_2", name: "safe-echo", input: { id: "b" } },
      ];

      const executor = new ToolExecutor(trackingRegistry, new MiddlewarePipeline());
      const results = await executor.runBatch(calls, baseCtx());

      expect(results).toHaveLength(2);
      // Both should start before either finishes (parallel execution)
      expect(executionOrder[0]).toContain("start:");
      expect(executionOrder[1]).toContain("start:");
    });

    it("returns results in same order as input", async () => {
      const registry = new InMemoryToolRegistry();
      registry.register(echoTool);
      registry.register(safeTool);

      const calls: ToolCall[] = [
        { id: "tc_1", name: "echo", input: { idx: 0 } },
        { id: "tc_2", name: "safe-echo", input: { idx: 1 } },
        { id: "tc_3", name: "echo", input: { idx: 2 } },
      ];

      const executor = new ToolExecutor(registry, new MiddlewarePipeline());
      const results = await executor.runBatch(calls, baseCtx());

      expect(results).toHaveLength(3);
      expect(results[0]!.call.id).toBe("tc_1");
      expect(results[1]!.call.id).toBe("tc_2");
      expect(results[2]!.call.id).toBe("tc_3");
    });

    it("returns empty array for empty calls", async () => {
      const executor = new ToolExecutor(new InMemoryToolRegistry(), new MiddlewarePipeline());
      const results = await executor.runBatch([], baseCtx());
      expect(results).toHaveLength(0);
    });

    it("throws for unknown tool in batch", async () => {
      const registry = new InMemoryToolRegistry();
      const executor = new ToolExecutor(registry, new MiddlewarePipeline());

      const calls: ToolCall[] = [{ id: "tc_1", name: "nonexistent", input: {} }];
      await expect(executor.runBatch(calls, baseCtx())).rejects.toThrow(
        "Tool not found: nonexistent",
      );
    });

    it("runs middleware onError and emits tool_failed audit in batch", async () => {
      const registry = new InMemoryToolRegistry();
      registry.register(failTool);

      let onErrorCalled = false;
      const events: string[] = [];
      const pipeline = new MiddlewarePipeline([
        {
          name: "error-mw",
          onError: () => {
            onErrorCalled = true;
          },
        },
      ]);
      const executor = new ToolExecutor(registry, pipeline);
      const ctx = baseCtx();
      ctx.services.audit = {
        log: (event) => {
          events.push(event.type);
        },
      };

      await expect(
        executor.runBatch([{ id: "tc_1", name: "fail", input: {} }], ctx),
      ).rejects.toThrow("Tool failed");
      expect(onErrorCalled).toBe(true);
      expect(events).toContain("tool_failed");
    });

    it("retries retryable errors in batch and then succeeds", async () => {
      const registry = new InMemoryToolRegistry();
      let called = 0;
      registry.register({
        name: "flaky-batch",
        description: "fails once",
        schema: z.object({}).passthrough(),
        invoke: async (): Promise<ToolResult> => {
          called += 1;
          if (called === 1) {
            throw new AgentError({
              code: "TOOL_ERROR",
              message: "temporary batch error",
              retryable: true,
            });
          }
          return { content: "ok" };
        },
      });

      const executor = new ToolExecutor(registry, new MiddlewarePipeline(), undefined, undefined, {
        toolMaxRetries: 1,
        retryBaseDelayMs: 1,
        retryMaxDelayMs: 1,
      });
      const results = await executor.runBatch(
        [{ id: "tc_1", name: "flaky-batch", input: {} }],
        baseCtx(),
      );
      expect(results).toHaveLength(1);
      expect(results[0]!.result.output.content).toBe("ok");
      expect(called).toBe(2);
    });
  });
});

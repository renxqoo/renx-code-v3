import { describe, expect, it } from "vitest";

import type { ModelClient, ModelResponse, ToolCall } from "@renx/model";

import { AgentRuntime } from "../src/runtime";
import { InMemoryCheckpointStore } from "../src/checkpoint";
import { MiddlewarePipeline } from "../src/middleware/pipeline";
import type { AgentTool, ToolResult } from "../src/tool/types";
import type { PolicyEngine } from "../src/types";
import { baseCtx } from "./helpers";

// --- Mock ModelClient ---

function createMockModelClient(responses: ModelResponse[]): ModelClient {
  let index = 0;
  return {
    generate: async () => responses[index++] ?? { type: "final", output: "done" },
    stream: async function* () {
      yield { type: "done" };
    },
    resolve: () => ({
      logicalModel: "test",
      provider: "test",
      providerModel: "test",
    }),
  };
}

// --- Test tools ---

const echoTool: AgentTool = {
  name: "echo",
  description: "Echoes input",
  invoke: async (input: unknown): Promise<ToolResult> => ({
    content: JSON.stringify(input),
  }),
};

// --- Helpers ---

function buildRuntimeConfig(overrides: {
  name?: string;
  modelClient: ModelClient;
  model?: string;
  tools?: AgentTool[];
  systemPrompt?: string;
  maxSteps?: number;
  checkpoint?: InMemoryCheckpointStore;
  pipeline?: MiddlewarePipeline;
  policy?: PolicyEngine;
  audit?: {
    log: (event: {
      id: string;
      runId: string;
      type: string;
      timestamp: string;
      payload: Record<string, unknown>;
    }) => void;
  };
}) {
  return {
    name: overrides.name ?? "test",
    modelClient: overrides.modelClient,
    model: overrides.model ?? "test-model",
    tools: overrides.tools ?? [],
    systemPrompt: overrides.systemPrompt ?? "You are helpful.",
    maxSteps: overrides.maxSteps ?? 5,
    ...(overrides.checkpoint ? { checkpoint: overrides.checkpoint } : {}),
    ...(overrides.pipeline ? { pipeline: overrides.pipeline } : {}),
    ...(overrides.policy ? { policy: overrides.policy } : {}),
    ...(overrides.audit ? { audit: overrides.audit } : {}),
  };
}

describe("AgentRuntime", () => {
  it("returns final response in single turn", async () => {
    const modelClient = createMockModelClient([
      { type: "final", output: "Hello! How can I help?" },
    ]);

    const runtime = new AgentRuntime(buildRuntimeConfig({ modelClient }));

    const ctx = baseCtx({ inputText: "Hi" });
    const result = await runtime.run(ctx);

    expect(result.status).toBe("completed");
    expect(result.output).toBe("Hello! How can I help?");
  });

  it("handles tool calls followed by final response", async () => {
    const toolCalls: ToolCall[] = [{ id: "tc_1", name: "echo", input: { msg: "hello" } }];

    const modelClient = createMockModelClient([
      { type: "tool_calls", toolCalls },
      { type: "final", output: "I echoed your message." },
    ]);

    const runtime = new AgentRuntime(
      buildRuntimeConfig({
        modelClient,
        tools: [echoTool],
      }),
    );

    const ctx = baseCtx({ inputText: "Echo hello" });
    const result = await runtime.run(ctx);

    expect(result.status).toBe("completed");
    expect(result.output).toBe("I echoed your message.");
    // Should have: user msg, assistant tool-call msg, tool result msg, assistant final msg
    expect(result.state.messages.length).toBeGreaterThanOrEqual(3);
  });

  it("fails when max steps exceeded", async () => {
    // Always return tool calls to force infinite loop
    const modelClient = createMockModelClient(
      Array.from({ length: 20 }, () => ({
        type: "tool_calls" as const,
        toolCalls: [{ id: "tc_loop", name: "echo", input: {} } as ToolCall],
      })),
    );

    const runtime = new AgentRuntime(
      buildRuntimeConfig({
        modelClient,
        tools: [echoTool],
        systemPrompt: "You loop forever.",
        maxSteps: 3,
      }),
    );

    const ctx = baseCtx({ inputText: "Loop" });
    const result = await runtime.run(ctx);

    expect(result.status).toBe("failed");
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("MAX_STEPS_EXCEEDED");
  });

  it("handles model errors gracefully", async () => {
    const modelClient: ModelClient = {
      generate: async () => {
        throw new Error("Model unavailable");
      },
      stream: async function* () {
        yield { type: "done" };
      },
      resolve: () => ({
        logicalModel: "test",
        provider: "test",
        providerModel: "test",
      }),
    };

    const runtime = new AgentRuntime(buildRuntimeConfig({ modelClient }));

    const ctx = baseCtx({ inputText: "Hi" });
    const result = await runtime.run(ctx);

    expect(result.status).toBe("failed");
    expect(result.error!.code).toBe("SYSTEM_ERROR");
  });

  it("saves checkpoints during run", async () => {
    const checkpoint = new InMemoryCheckpointStore();
    const modelClient = createMockModelClient([{ type: "final", output: "Done!" }]);

    const runtime = new AgentRuntime(buildRuntimeConfig({ modelClient, checkpoint }));

    const ctx = baseCtx({ inputText: "Hi" });
    const result = await runtime.run(ctx);

    expect(result.status).toBe("completed");
    const record = await checkpoint.load(result.runId);
    expect(record).toBeDefined();
    expect(record!.state.status).toBe("completed");
  });

  it("applies tool statePatch to context", async () => {
    const statePatchingTool: AgentTool = {
      name: "patch-state",
      description: "Patches agent state",
      invoke: async (): Promise<ToolResult> => ({
        content: "State patched",
        statePatch: { mergeMemory: { injected: true } },
      }),
    };

    const modelClient = createMockModelClient([
      {
        type: "tool_calls",
        toolCalls: [{ id: "tc_1", name: "patch-state", input: {} }],
      },
      { type: "final", output: "Done!" },
    ]);

    const runtime = new AgentRuntime(
      buildRuntimeConfig({
        modelClient,
        tools: [statePatchingTool],
        systemPrompt: "You patch state.",
      }),
    );

    const ctx = baseCtx({ inputText: "Patch" });
    const result = await runtime.run(ctx);

    expect(result.status).toBe("completed");
    expect(result.state.memory).toEqual({ injected: true });
  });

  it("Policy denies tool use produces POLICY_DENIED error", async () => {
    const denyPolicy: PolicyEngine = {
      filterTools: (_ctx, tools) => tools,
      canUseTool: () => false,
    };

    const modelClient = createMockModelClient([
      {
        type: "tool_calls",
        toolCalls: [{ id: "tc_1", name: "echo", input: { msg: "hello" } }],
      },
    ]);

    const runtime = new AgentRuntime(
      buildRuntimeConfig({
        modelClient,
        tools: [echoTool],
        policy: denyPolicy,
      }),
    );

    const ctx = baseCtx({ inputText: "Echo" });
    const result = await runtime.run(ctx);

    expect(result.status).toBe("failed");
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("POLICY_DENIED");
  });

  it("TOOL_NOT_FOUND error for unknown tool", async () => {
    const modelClient = createMockModelClient([
      {
        type: "tool_calls",
        toolCalls: [{ id: "tc_1", name: "nonexistent_tool", input: {} }],
      },
    ]);

    const runtime = new AgentRuntime(
      buildRuntimeConfig({
        modelClient,
        tools: [], // no tools registered
      }),
    );

    const ctx = baseCtx({ inputText: "Use missing tool" });
    const result = await runtime.run(ctx);

    expect(result.status).toBe("failed");
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("TOOL_NOT_FOUND");
  });

  it("Middleware lifecycle: beforeModel modifies request, afterModel modifies response", async () => {
    let beforeModelCalled = false;
    let afterModelCalled = false;

    const pipeline = new MiddlewarePipeline([
      {
        name: "lifecycle-mw",
        beforeModel: (_ctx, req) => {
          beforeModelCalled = true;
          return { ...req, systemPrompt: req.systemPrompt + " [modified]" };
        },
        afterModel: (_ctx, resp) => {
          afterModelCalled = true;
          return { ...resp, output: (resp as { output: string }).output + " [after]" };
        },
      },
    ]);

    const modelClient = createMockModelClient([{ type: "final", output: "Hello!" }]);

    const runtime = new AgentRuntime(
      buildRuntimeConfig({
        modelClient,
        pipeline,
      }),
    );

    const ctx = baseCtx({ inputText: "Hi" });
    const result = await runtime.run(ctx);

    expect(beforeModelCalled).toBe(true);
    expect(afterModelCalled).toBe(true);
    expect(result.output).toBe("Hello! [after]");
  });

  it("Multiple tool calls in single model response", async () => {
    const toolCalls: ToolCall[] = [
      { id: "tc_1", name: "echo", input: { msg: "first" } },
      { id: "tc_2", name: "echo", input: { msg: "second" } },
    ];

    const modelClient = createMockModelClient([
      { type: "tool_calls", toolCalls },
      { type: "final", output: "Both echoed!" },
    ]);

    const runtime = new AgentRuntime(
      buildRuntimeConfig({
        modelClient,
        tools: [echoTool],
      }),
    );

    const ctx = baseCtx({ inputText: "Echo twice" });
    const result = await runtime.run(ctx);

    expect(result.status).toBe("completed");
    expect(result.output).toBe("Both echoed!");
    // Should have: user + assistant(toolCalls) + tool_result(tc_1) + tool_result(tc_2) + assistant(final)
    expect(result.state.messages.length).toBeGreaterThanOrEqual(4);
  });

  it("Tool execution failure results in failed run", async () => {
    const failTool: AgentTool = {
      name: "fail",
      description: "Always fails",
      invoke: async (): Promise<ToolResult> => {
        throw new Error("Tool execution exploded");
      },
    };

    const modelClient = createMockModelClient([
      {
        type: "tool_calls",
        toolCalls: [{ id: "tc_1", name: "fail", input: {} }],
      },
    ]);

    const runtime = new AgentRuntime(
      buildRuntimeConfig({
        modelClient,
        tools: [failTool],
      }),
    );

    const ctx = baseCtx({ inputText: "Run failing tool" });
    const result = await runtime.run(ctx);

    expect(result.status).toBe("failed");
    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain("Tool execution exploded");
  });

  it("Empty input (no inputText, no messages) still works", async () => {
    const modelClient = createMockModelClient([{ type: "final", output: "I'm ready to help." }]);

    const runtime = new AgentRuntime(buildRuntimeConfig({ modelClient }));

    const ctx = baseCtx(); // no inputText
    const result = await runtime.run(ctx);

    expect(result.status).toBe("completed");
    expect(result.output).toBe("I'm ready to help.");
  });

  it("Audit events have correct runId", async () => {
    const events: { type: string; runId: string }[] = [];
    const auditLogger = {
      log: (event: { type: string; runId: string }) => {
        events.push({ type: event.type, runId: event.runId });
      },
    };

    const modelClient = createMockModelClient([{ type: "final", output: "Done!" }]);

    const runtime = new AgentRuntime(
      buildRuntimeConfig({
        modelClient,
        audit: auditLogger,
      }),
    );

    const ctx = baseCtx({ inputText: "Hi" });
    const result = await runtime.run(ctx);

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.runId).toBe(result.runId);
      expect(event.runId).not.toBe("");
    }
  });
});

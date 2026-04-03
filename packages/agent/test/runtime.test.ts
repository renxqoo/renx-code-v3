import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ModelClient, ModelResponse, ToolCall } from "@renx/model";

import { AgentRuntime } from "../src/runtime";
import { AgentError } from "../src/errors";
import { InMemoryTimelineStore } from "../src/timeline";
import { MiddlewarePipeline } from "../src/middleware/pipeline";
import type { AgentTool, ToolResult } from "../src/tool/types";
import type { AgentResult, AgentStreamEvent, ApprovalEngine, PolicyEngine } from "../src/types";
import type { RunMessage } from "../src/message/types";
import { baseCtx } from "./helpers";

// --- Mock ModelClient ---

function createMockModelClient(responses: ModelResponse[]): ModelClient {
  let generateIndex = 0;
  let streamIndex = 0;
  return {
    generate: async () => responses[generateIndex++] ?? { type: "final", output: "done" },
    async *stream(_request) {
      const resp = responses[streamIndex++] ?? { type: "final" as const, output: "done" };
      if (resp.type === "final") {
        yield { type: "text_delta" as const, text: resp.output };
      } else if (resp.type === "tool_calls") {
        for (const call of resp.toolCalls) {
          yield { type: "tool_call" as const, call };
        }
      }
      yield { type: "done" as const };
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
  schema: z.object({}).passthrough(),
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
  timeline?: InMemoryTimelineStore;
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
  context?: {
    maxInputTokens: number;
    maxOutputTokens: number;
    maxPromptTooLongRetries: number;
    maxReactiveCompactAttempts: number;
    maxCompactRequestRetries: number;
    compactRequestMaxInputChars: number;
    maxConsecutiveCompactFailures: number;
    toolResultSoftCharLimit: number;
    historySnipKeepRounds: number;
    historySnipMaxDropRounds: number;
    microcompactMaxToolChars: number;
    collapseRestoreMaxMessages: number;
    collapseRestoreTokenHeadroomRatio: number;
    rehydrationTokenBudget: number;
    recentFileBudgetTokens: number;
    skillsRehydrateBudgetTokens: number;
    thresholds: {
      warningBufferTokens: number;
      autoCompactBufferTokens: number;
      errorBufferTokens: number;
      blockingHeadroomTokens: number;
    };
  };
}) {
  return {
    name: overrides.name ?? "test",
    modelClient: overrides.modelClient,
    model: overrides.model ?? "test-model",
    tools: overrides.tools ?? [],
    systemPrompt: overrides.systemPrompt ?? "You are helpful.",
    maxSteps: overrides.maxSteps ?? 5,
    ...(overrides.timeline ? { timeline: overrides.timeline } : {}),
    ...(overrides.pipeline ? { pipeline: overrides.pipeline } : {}),
    ...(overrides.policy ? { policy: overrides.policy } : {}),
    ...(overrides.audit ? { audit: overrides.audit } : {}),
    ...(overrides.context ? { context: overrides.context } : {}),
  };
}

function buildInputMessages(count: number): RunMessage[] {
  return Array.from({ length: count }, (_, idx) => ({
    id: `in_${idx}`,
    messageId: `in_msg_${idx}`,
    role: idx % 2 === 0 ? "user" : "assistant",
    content: `content-${idx}-${"x".repeat(120)}`,
    createdAt: new Date(1_700_000_000_000 + idx).toISOString(),
    source: "input",
    roundIndex: Math.floor(idx / 2),
  }));
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
    const assistantToolCall = result.state.messages.find(
      (m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0,
    );
    const toolResultMsg = result.state.messages.find(
      (m) => m.role === "tool" && m.toolCallId === "tc_1",
    );
    expect(assistantToolCall?.atomicGroupId).toBeDefined();
    expect(toolResultMsg?.atomicGroupId).toBe(assistantToolCall?.atomicGroupId);
    expect(assistantToolCall?.thinkingChunkGroupId).toBeDefined();
    expect(toolResultMsg?.thinkingChunkGroupId).toBe(assistantToolCall?.thinkingChunkGroupId);
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

  it("retries model call on retryable error and succeeds", async () => {
    let called = 0;
    const modelClient: ModelClient = {
      generate: async () => {
        called += 1;
        if (called === 1) {
          throw new AgentError({
            code: "MODEL_ERROR",
            message: "upstream temporary failure",
            retryable: true,
          });
        }
        return { type: "final", output: "Recovered after retry" };
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

    const runtime = new AgentRuntime(buildRuntimeConfig({ modelClient }));
    const result = await runtime.run(baseCtx({ inputText: "hello" }));

    expect(result.status).toBe("completed");
    expect(result.output).toBe("Recovered after retry");
    expect(called).toBe(2);
  });

  it("does not retry model call on non-retryable error", async () => {
    let called = 0;
    const modelClient: ModelClient = {
      generate: async () => {
        called += 1;
        throw new AgentError({
          code: "MODEL_ERROR",
          message: "hard failure",
          retryable: false,
        });
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

    const runtime = new AgentRuntime(buildRuntimeConfig({ modelClient }));
    const result = await runtime.run(baseCtx({ inputText: "hello" }));

    expect(result.status).toBe("failed");
    expect(called).toBe(1);
  });

  it("retries retryable tool failure and succeeds", async () => {
    let toolCalled = 0;
    const flakyTool: AgentTool = {
      name: "flaky",
      description: "fails once then succeeds",
      schema: z.object({}).passthrough(),
      invoke: async (): Promise<ToolResult> => {
        toolCalled += 1;
        if (toolCalled === 1) {
          throw new AgentError({
            code: "TOOL_ERROR",
            message: "temporary tool failure",
            retryable: true,
          });
        }
        return { content: "tool-ok" };
      },
    };
    const modelClient = createMockModelClient([
      {
        type: "tool_calls",
        toolCalls: [{ id: "tc_1", name: "flaky", input: {} }],
      },
      { type: "final", output: "done" },
    ]);
    const runtime = new AgentRuntime(
      buildRuntimeConfig({
        modelClient,
        tools: [flakyTool],
      }),
    );

    const result = await runtime.run(baseCtx({ inputText: "run flaky" }));
    expect(result.status).toBe("completed");
    expect(result.output).toBe("done");
    expect(toolCalled).toBe(2);
  });

  it("does not retry non-retryable tool failure and returns tool error payload", async () => {
    let toolCalled = 0;
    const hardFailTool: AgentTool = {
      name: "hard-fail",
      description: "always fails",
      schema: z.object({}).passthrough(),
      invoke: async (): Promise<ToolResult> => {
        toolCalled += 1;
        throw new AgentError({
          code: "TOOL_ERROR",
          message: "hard tool failure",
          retryable: false,
        });
      },
    };
    const modelClient = createMockModelClient([
      {
        type: "tool_calls",
        toolCalls: [{ id: "tc_1", name: "hard-fail", input: {} }],
      },
    ]);
    const runtime = new AgentRuntime(
      buildRuntimeConfig({
        modelClient,
        tools: [hardFailTool],
      }),
    );

    const result = await runtime.run(baseCtx({ inputText: "run hard-fail" }));
    expect(result.status).toBe("completed");
    expect(result.output).toBe("done");
    expect(
      result.state.messages.some(
        (m) =>
          m.role === "tool" && m.toolCallId === "tc_1" && m.content.includes('"code":"TOOL_ERROR"'),
      ),
    ).toBe(true);
    expect(toolCalled).toBe(1);
  });

  it("calls afterRun with failed result in run() catch branch", async () => {
    let afterRunCalled = false;
    let afterRunStatus: string | undefined;
    const pipeline = new MiddlewarePipeline([
      {
        name: "after-run-capture",
        afterRun: (_ctx, result) => {
          afterRunCalled = true;
          afterRunStatus = result.status;
        },
      },
    ]);

    const modelClient: ModelClient = {
      generate: async () => {
        throw new Error("run crash");
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

    const runtime = new AgentRuntime(buildRuntimeConfig({ modelClient, pipeline }));
    const result = await runtime.run(baseCtx({ inputText: "Hi" }));

    expect(result.status).toBe("failed");
    expect(afterRunCalled).toBe(true);
    expect(afterRunStatus).toBe("failed");
  });

  it("does not expose output when run fails in finalize phase", async () => {
    const pipeline = new MiddlewarePipeline([
      {
        name: "after-run-crash",
        afterRun: () => {
          throw new Error("afterRun crashed");
        },
      },
    ]);
    const modelClient = createMockModelClient([
      { type: "final", output: "final but should be hidden" },
    ]);
    const runtime = new AgentRuntime(buildRuntimeConfig({ modelClient, pipeline }));

    const result = await runtime.run(baseCtx({ inputText: "Hi" }));

    expect(result.status).toBe("failed");
    expect(result.output).toBeUndefined();
  });

  it("does not expose output when stream fails in finalize phase", async () => {
    const pipeline = new MiddlewarePipeline([
      {
        name: "after-run-crash-stream",
        afterRun: () => {
          throw new Error("afterRun crashed");
        },
      },
    ]);
    const modelClient = createMockModelClient([
      { type: "final", output: "stream final but hidden" },
    ]);
    const runtime = new AgentRuntime(buildRuntimeConfig({ modelClient, pipeline }));

    const iter = runtime.stream(baseCtx({ inputText: "Hi stream" }));
    let done: IteratorResult<AgentStreamEvent, AgentResult> | undefined;
    while (true) {
      const next = await iter.next();
      if (next.done) {
        done = next;
        break;
      }
    }

    expect(done).toBeDefined();
    expect(done!.value.status).toBe("failed");
    expect(done!.value.output).toBeUndefined();
  });

  it("saves timeline snapshots during run", async () => {
    const timeline = new InMemoryTimelineStore();
    const modelClient = createMockModelClient([{ type: "final", output: "Done!" }]);

    const runtime = new AgentRuntime(buildRuntimeConfig({ modelClient, timeline }));

    const ctx = baseCtx({ inputText: "Hi" });
    const result = await runtime.run(ctx);

    expect(result.status).toBe("completed");
    const record = await timeline.load(result.runId);
    expect(record).toBeDefined();
    expect(record!.state.status).toBe("completed");
  });

  it("applies tool statePatch to context", async () => {
    const statePatchingTool: AgentTool = {
      name: "patch-state",
      description: "Patches agent state",
      schema: z.object({}).passthrough(),
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

  it("executes pending tool after approval and resume", async () => {
    let toolCalled = 0;
    const approvalRequests: string[] = [];
    const approvalDecisions = new Map<string, "pending" | "approved" | "rejected" | "expired">();
    const approvalEngine: ApprovalEngine = {
      evaluate: (_ctx, tool) => ({
        required: tool.name === "gated",
        reason: 'tool "gated" needs approval',
      }),
      request: async (_ctx, ticket) => {
        approvalRequests.push(ticket.id);
        approvalDecisions.set(ticket.id, "pending");
      },
      getDecision: async (_ctx, ticketId) => {
        const status = approvalDecisions.get(ticketId);
        if (!status) return null;
        return {
          ticketId,
          status,
          reviewerId: status === "approved" ? "reviewer-1" : "reviewer-x",
          decidedAt: new Date().toISOString(),
        };
      },
    };
    const gatedTool: AgentTool = {
      name: "gated",
      description: "requires approval",
      schema: z.object({}).passthrough(),
      invoke: async (): Promise<ToolResult> => {
        toolCalled += 1;
        return { content: "approved tool output" };
      },
    };
    const policy: PolicyEngine = {
      filterTools: (_ctx, tools) => tools,
      canUseTool: () => true,
    };
    const timeline = new InMemoryTimelineStore();
    const modelClient = createMockModelClient([
      {
        type: "tool_calls",
        toolCalls: [{ id: "tc_approval_1", name: "gated", input: { op: "run" } }],
      },
      { type: "final", output: "completed after approval" },
    ]);
    const runtime = new AgentRuntime(
      buildRuntimeConfig({
        modelClient,
        tools: [gatedTool],
        policy,
        timeline,
      }),
    );

    const firstCtx = baseCtx({ inputText: "run gated" });
    firstCtx.services.approvalEngine = approvalEngine;
    const first = await runtime.run(firstCtx);
    expect(first.status).toBe("waiting_approval");
    expect(toolCalled).toBe(0);
    expect(approvalRequests.length).toBe(1);

    const ticketId = approvalRequests[0]!;
    approvalDecisions.set(ticketId, "approved");

    const record = await timeline.load(first.runId);
    expect(record).toBeDefined();
    const resumed = await runtime.run({
      input: {},
      identity: firstCtx.identity,
      state: { ...record!.state, status: "running" },
      services: { approvalEngine },
      metadata: {},
    });

    expect(resumed.status).toBe("completed");
    expect(resumed.output).toBe("completed after approval");
    expect(toolCalled).toBe(1);
    expect(
      resumed.state.messages.some((m) => m.role === "tool" && m.toolCallId === "tc_approval_1"),
    ).toBe(true);
  });

  it("fails resume when pending approval is rejected", async () => {
    let toolCalled = 0;
    const approvalRequests: string[] = [];
    const approvalDecisions = new Map<string, "pending" | "approved" | "rejected" | "expired">();
    const approvalEngine: ApprovalEngine = {
      evaluate: () => ({ required: true }),
      request: async (_ctx, ticket) => {
        approvalRequests.push(ticket.id);
        approvalDecisions.set(ticket.id, "pending");
      },
      getDecision: async (_ctx, ticketId) => {
        const status = approvalDecisions.get(ticketId);
        if (!status) return null;
        return {
          ticketId,
          status,
          reviewerId: "reviewer-2",
          decidedAt: new Date().toISOString(),
        };
      },
    };
    const gatedTool: AgentTool = {
      name: "gated",
      description: "requires approval",
      schema: z.object({}).passthrough(),
      invoke: async (): Promise<ToolResult> => {
        toolCalled += 1;
        return { content: "should not run" };
      },
    };
    const policy: PolicyEngine = {
      filterTools: (_ctx, tools) => tools,
      canUseTool: () => true,
    };
    const timeline = new InMemoryTimelineStore();
    const modelClient = createMockModelClient([
      {
        type: "tool_calls",
        toolCalls: [{ id: "tc_approval_2", name: "gated", input: { op: "run" } }],
      },
    ]);
    const runtime = new AgentRuntime(
      buildRuntimeConfig({
        modelClient,
        tools: [gatedTool],
        policy,
        timeline,
      }),
    );

    const firstCtx = baseCtx({ inputText: "run gated" });
    firstCtx.services.approvalEngine = approvalEngine;
    const first = await runtime.run(firstCtx);
    expect(first.status).toBe("waiting_approval");
    expect(toolCalled).toBe(0);
    expect(approvalRequests.length).toBe(1);

    const ticketId = approvalRequests[0]!;
    approvalDecisions.set(ticketId, "rejected");

    const record = await timeline.load(first.runId);
    expect(record).toBeDefined();
    const resumed = await runtime.run({
      input: {},
      identity: firstCtx.identity,
      state: { ...record!.state, status: "running" },
      services: { approvalEngine },
      metadata: {},
    });

    expect(resumed.status).toBe("failed");
    expect(resumed.error?.code).toBe("APPROVAL_REQUIRED");
    expect(toolCalled).toBe(0);
  });

  it("fails with APPROVAL_REQUIRED when pending ticket is expired", async () => {
    let toolCalled = 0;
    const approvalRequests: string[] = [];
    const approvalEngine: ApprovalEngine = {
      evaluate: () => ({
        required: true,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      request: async (_ctx, ticket) => {
        approvalRequests.push(ticket.id);
      },
      getDecision: async () => null,
    };
    const gatedTool: AgentTool = {
      name: "gated",
      description: "requires approval",
      schema: z.object({}).passthrough(),
      invoke: async (): Promise<ToolResult> => {
        toolCalled += 1;
        return { content: "should not run" };
      },
    };
    const policy: PolicyEngine = {
      filterTools: (_ctx, tools) => tools,
      canUseTool: () => true,
    };
    const timeline = new InMemoryTimelineStore();
    const modelClient = createMockModelClient([
      {
        type: "tool_calls",
        toolCalls: [{ id: "tc_approval_expired", name: "gated", input: { op: "run" } }],
      },
    ]);
    const runtime = new AgentRuntime(
      buildRuntimeConfig({
        modelClient,
        tools: [gatedTool],
        policy,
        timeline,
      }),
    );

    const firstCtx = baseCtx({ inputText: "run gated" });
    firstCtx.services.approvalEngine = approvalEngine;
    const first = await runtime.run(firstCtx);
    expect(first.status).toBe("waiting_approval");
    expect(approvalRequests.length).toBe(1);

    const record = await timeline.load(first.runId);
    expect(record).toBeDefined();
    const resumed = await runtime.run({
      input: {},
      identity: firstCtx.identity,
      state: { ...record!.state, status: "running" },
      services: { approvalEngine },
      metadata: {},
    });

    expect(resumed.status).toBe("failed");
    expect(resumed.error?.code).toBe("APPROVAL_REQUIRED");
    expect(toolCalled).toBe(0);
    expect(String(resumed.error?.metadata?.["status"] ?? "")).toBe("expired");
  });

  it("fails with SYSTEM_ERROR when pending approval resumes without ApprovalEngine", async () => {
    const approvalEngine: ApprovalEngine = {
      evaluate: () => ({ required: true }),
      request: async () => {},
      getDecision: async () => null,
    };
    const gatedTool: AgentTool = {
      name: "gated",
      description: "requires approval",
      schema: z.object({}).passthrough(),
      invoke: async (): Promise<ToolResult> => ({ content: "n/a" }),
    };
    const timeline = new InMemoryTimelineStore();
    const runtime = new AgentRuntime(
      buildRuntimeConfig({
        modelClient: createMockModelClient([
          { type: "tool_calls", toolCalls: [{ id: "tc_no_engine", name: "gated", input: {} }] },
        ]),
        tools: [gatedTool],
        policy: {
          filterTools: (_ctx, tools) => tools,
          canUseTool: () => true,
        },
        timeline,
      }),
    );
    const firstCtx = baseCtx({ inputText: "run" });
    firstCtx.services.approvalEngine = approvalEngine;
    const first = await runtime.run(firstCtx);
    expect(first.status).toBe("waiting_approval");

    const record = await timeline.load(first.runId);
    expect(record).toBeDefined();
    const resumed = await runtime.run({
      input: {},
      identity: firstCtx.identity,
      state: { ...record!.state, status: "running" },
      services: {},
      metadata: {},
    });
    expect(resumed.status).toBe("failed");
    expect(resumed.error?.code).toBe("SYSTEM_ERROR");
  });

  it("fails with SYSTEM_ERROR when approval decision ticket mismatches", async () => {
    const approvalRequests: string[] = [];
    const approvalEngine: ApprovalEngine = {
      evaluate: () => ({ required: true }),
      request: async (_ctx, ticket) => {
        approvalRequests.push(ticket.id);
      },
      getDecision: async () => ({
        ticketId: "ticket_other",
        status: "approved",
        reviewerId: "reviewer-x",
      }),
    };
    const gatedTool: AgentTool = {
      name: "gated",
      description: "requires approval",
      schema: z.object({}).passthrough(),
      invoke: async (): Promise<ToolResult> => ({ content: "n/a" }),
    };
    const timeline = new InMemoryTimelineStore();
    const runtime = new AgentRuntime(
      buildRuntimeConfig({
        modelClient: createMockModelClient([
          { type: "tool_calls", toolCalls: [{ id: "tc_mismatch", name: "gated", input: {} }] },
        ]),
        tools: [gatedTool],
        policy: {
          filterTools: (_ctx, tools) => tools,
          canUseTool: () => true,
        },
        timeline,
      }),
    );
    const firstCtx = baseCtx({ inputText: "run" });
    firstCtx.services.approvalEngine = approvalEngine;
    const first = await runtime.run(firstCtx);
    expect(first.status).toBe("waiting_approval");
    expect(approvalRequests.length).toBe(1);

    const record = await timeline.load(first.runId);
    expect(record).toBeDefined();
    const resumed = await runtime.run({
      input: {},
      identity: firstCtx.identity,
      state: { ...record!.state, status: "running" },
      services: { approvalEngine },
      metadata: {},
    });
    expect(resumed.status).toBe("failed");
    expect(resumed.error?.code).toBe("SYSTEM_ERROR");
  });

  it("does not execute approved pending ticket twice when resumed from stale snapshot", async () => {
    let toolCalled = 0;
    const approvalRequests: string[] = [];
    const approvalDecisions = new Map<string, "pending" | "approved" | "rejected" | "expired">();
    const approvalEngine: ApprovalEngine = {
      evaluate: () => ({ required: true }),
      request: async (_ctx, ticket) => {
        approvalRequests.push(ticket.id);
        approvalDecisions.set(ticket.id, "pending");
      },
      getDecision: async (_ctx, ticketId) => {
        const status = approvalDecisions.get(ticketId);
        if (!status) return null;
        return {
          ticketId,
          status,
          reviewerId: "reviewer-1",
          decidedAt: new Date().toISOString(),
        };
      },
    };
    const gatedTool: AgentTool = {
      name: "gated",
      description: "requires approval",
      schema: z.object({}).passthrough(),
      invoke: async (): Promise<ToolResult> => {
        toolCalled += 1;
        return { content: "tool-ran" };
      },
    };
    const timeline = new InMemoryTimelineStore();
    const runtime = new AgentRuntime(
      buildRuntimeConfig({
        modelClient: createMockModelClient([
          {
            type: "tool_calls",
            toolCalls: [{ id: "tc_stale_1", name: "gated", input: { op: "run" } }],
          },
          { type: "final", output: "after-first-resume" },
          { type: "final", output: "after-second-resume" },
        ]),
        tools: [gatedTool],
        policy: {
          filterTools: (_ctx, tools) => tools,
          canUseTool: () => true,
        },
        timeline,
      }),
    );

    const firstCtx = baseCtx({ inputText: "run" });
    firstCtx.services.approvalEngine = approvalEngine;
    const first = await runtime.run(firstCtx);
    expect(first.status).toBe("waiting_approval");
    const ticketId = approvalRequests[0]!;
    approvalDecisions.set(ticketId, "approved");

    const record = await timeline.load(first.runId);
    expect(record).toBeDefined();
    const staleState = { ...record!.state, status: "running" as const };

    const resumed1 = await runtime.run({
      input: {},
      identity: firstCtx.identity,
      state: { ...staleState },
      services: { approvalEngine },
      metadata: {},
    });
    const resumed2 = await runtime.run({
      input: {},
      identity: firstCtx.identity,
      state: { ...staleState },
      services: { approvalEngine },
      metadata: {},
    });

    expect(resumed1.status).toBe("completed");
    expect(resumed2.status).toBe("completed");
    expect(toolCalled).toBe(1);
  });

  it("does not execute approved pending ticket twice across runtime instances", async () => {
    let toolCalled = 0;
    const approvalRequests: string[] = [];
    const approvalDecisions = new Map<string, "pending" | "approved" | "rejected" | "expired">();
    const approvalEngine: ApprovalEngine = {
      evaluate: () => ({ required: true }),
      request: async (_ctx, ticket) => {
        approvalRequests.push(ticket.id);
        approvalDecisions.set(ticket.id, "pending");
      },
      getDecision: async (_ctx, ticketId) => {
        const status = approvalDecisions.get(ticketId);
        if (!status) return null;
        return {
          ticketId,
          status,
          reviewerId: "reviewer-1",
          decidedAt: new Date().toISOString(),
        };
      },
    };
    const gatedTool: AgentTool = {
      name: "gated",
      description: "requires approval",
      schema: z.object({}).passthrough(),
      invoke: async (): Promise<ToolResult> => {
        toolCalled += 1;
        return { content: "tool-ran" };
      },
    };
    const timeline = new InMemoryTimelineStore();
    const runtime1 = new AgentRuntime(
      buildRuntimeConfig({
        modelClient: createMockModelClient([
          {
            type: "tool_calls",
            toolCalls: [{ id: "tc_cross_1", name: "gated", input: { op: "run" } }],
          },
          { type: "final", output: "runtime1 done" },
        ]),
        tools: [gatedTool],
        policy: {
          filterTools: (_ctx, tools) => tools,
          canUseTool: () => true,
        },
        timeline,
      }),
    );
    const runtime2 = new AgentRuntime(
      buildRuntimeConfig({
        modelClient: createMockModelClient([{ type: "final", output: "runtime2 done" }]),
        tools: [gatedTool],
        policy: {
          filterTools: (_ctx, tools) => tools,
          canUseTool: () => true,
        },
        timeline,
      }),
    );

    const firstCtx = baseCtx({ inputText: "run" });
    firstCtx.services.approvalEngine = approvalEngine;
    const first = await runtime1.run(firstCtx);
    expect(first.status).toBe("waiting_approval");
    const ticketId = approvalRequests[0]!;
    approvalDecisions.set(ticketId, "approved");

    const record = await timeline.load(first.runId);
    expect(record).toBeDefined();
    const staleState = { ...record!.state, status: "running" as const };

    const resumed1 = await runtime1.run({
      input: {},
      identity: firstCtx.identity,
      state: { ...staleState },
      services: { approvalEngine },
      metadata: {},
    });
    const afterFirstResumeRecord = await timeline.load(first.runId);
    expect(afterFirstResumeRecord).toBeDefined();
    const handledMap = afterFirstResumeRecord!.state.scratchpad["__handledApprovalTickets"] as
      | Record<string, unknown>
      | undefined;
    expect(handledMap?.[ticketId]).toBe(true);
    const resumed2 = await runtime2.run({
      input: {},
      identity: firstCtx.identity,
      state: { ...staleState },
      services: { approvalEngine },
      metadata: {},
    });

    expect(resumed1.status).toBe("completed");
    expect(resumed2.status).toBe("completed");
    expect(toolCalled).toBe(1);
  });

  it("does not execute approved pending ticket twice with concurrent resumes", async () => {
    let toolCalled = 0;
    let releaseTool: (() => void) | undefined;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const approvalRequests: string[] = [];
    const approvalDecisions = new Map<string, "pending" | "approved" | "rejected" | "expired">();
    const approvalEngine: ApprovalEngine = {
      evaluate: () => ({ required: true }),
      request: async (_ctx, ticket) => {
        approvalRequests.push(ticket.id);
        approvalDecisions.set(ticket.id, "pending");
      },
      getDecision: async (_ctx, ticketId) => {
        const status = approvalDecisions.get(ticketId);
        if (!status) return null;
        return {
          ticketId,
          status,
          reviewerId: "reviewer-concurrent",
          decidedAt: new Date().toISOString(),
        };
      },
    };
    const gatedTool: AgentTool = {
      name: "gated",
      description: "requires approval",
      schema: z.object({}).passthrough(),
      invoke: async (): Promise<ToolResult> => {
        toolCalled += 1;
        await toolGate;
        return { content: "tool-ran" };
      },
    };
    const timeline = new InMemoryTimelineStore();
    const runtime1 = new AgentRuntime(
      buildRuntimeConfig({
        modelClient: createMockModelClient([{ type: "final", output: "runtime1 done" }]),
        tools: [gatedTool],
        policy: {
          filterTools: (_ctx, tools) => tools,
          canUseTool: () => true,
        },
        timeline,
      }),
    );
    const runtime2 = new AgentRuntime(
      buildRuntimeConfig({
        modelClient: createMockModelClient([{ type: "final", output: "runtime2 done" }]),
        tools: [gatedTool],
        policy: {
          filterTools: (_ctx, tools) => tools,
          canUseTool: () => true,
        },
        timeline,
      }),
    );

    const initialRuntime = new AgentRuntime(
      buildRuntimeConfig({
        modelClient: createMockModelClient([
          {
            type: "tool_calls",
            toolCalls: [{ id: "tc_concurrent_1", name: "gated", input: { op: "run" } }],
          },
        ]),
        tools: [gatedTool],
        policy: {
          filterTools: (_ctx, tools) => tools,
          canUseTool: () => true,
        },
        timeline,
      }),
    );

    const firstCtx = baseCtx({ inputText: "run" });
    firstCtx.services.approvalEngine = approvalEngine;
    const first = await initialRuntime.run(firstCtx);
    expect(first.status).toBe("waiting_approval");
    const ticketId = approvalRequests[0]!;
    approvalDecisions.set(ticketId, "approved");

    const record = await timeline.load(first.runId);
    expect(record).toBeDefined();
    const staleState = { ...record!.state, status: "running" as const };

    const p1 = runtime1.run({
      input: {},
      identity: firstCtx.identity,
      state: { ...staleState },
      services: { approvalEngine },
      metadata: {},
    });
    const p2 = runtime2.run({
      input: {},
      identity: firstCtx.identity,
      state: { ...staleState },
      services: { approvalEngine },
      metadata: {},
    });

    await Promise.resolve();
    releaseTool?.();
    const [resumed1, resumed2] = await Promise.all([p1, p2]);

    const statuses = [resumed1.status, resumed2.status].sort();
    expect(statuses.every((status) => ["completed", "waiting_approval"].includes(status))).toBe(
      true,
    );
    expect(statuses.includes("completed")).toBe(true);
    expect(toolCalled).toBe(1);

    const latest = await timeline.load(first.runId);
    expect(latest).toBeDefined();
    const resumedFinal = await runtime1.run({
      input: {},
      identity: firstCtx.identity,
      state: { ...latest!.state, status: "running" },
      services: { approvalEngine },
      metadata: {},
    });
    expect(resumedFinal.status).toBe("completed");
    expect(toolCalled).toBe(1);
  });

  it("continues run and returns tool error payload for unknown tool", async () => {
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

    expect(result.status).toBe("completed");
    expect(result.error).toBeUndefined();
    expect(result.output).toBe("done");
    const toolMsg = result.state.messages.find((m) => m.role === "tool" && m.toolCallId === "tc_1");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.content).toContain('"code":"TOOL_NOT_FOUND"');
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

  it("afterAssistantFinal can request another reasoning round", async () => {
    const modelClient = createMockModelClient([
      { type: "final", output: "premature done" },
      { type: "final", output: "final verified answer" },
    ]);

    let guardCalled = 0;
    const pipeline = new MiddlewarePipeline([
      {
        name: "final-guard",
        afterAssistantFinal: () => {
          guardCalled += 1;
          if (guardCalled === 1) {
            return {
              continueWithUserMessage: "请继续执行，先完成任务再给最终回答。",
            };
          }
        },
      },
    ]);

    const runtime = new AgentRuntime(
      buildRuntimeConfig({
        modelClient,
        pipeline,
      }),
    );

    const result = await runtime.run(baseCtx({ inputText: "do task" }));
    expect(result.status).toBe("completed");
    expect(result.output).toBe("final verified answer");
    expect(
      result.state.messages.some((m) => m.role === "assistant" && m.content === "premature done"),
    ).toBe(false);
    expect(
      result.state.messages.some(
        (m) => m.role === "user" && m.content.includes("请继续执行，先完成任务再给最终回答。"),
      ),
    ).toBe(true);
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

  it("Tool execution failure returns tool error payload and continues", async () => {
    const failTool: AgentTool = {
      name: "fail",
      description: "Always fails",
      schema: z.object({}).passthrough(),
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

    expect(result.status).toBe("completed");
    expect(result.output).toBe("done");
    expect(
      result.state.messages.some(
        (m) =>
          m.role === "tool" &&
          m.toolCallId === "tc_1" &&
          m.content.includes("Tool execution exploded"),
      ),
    ).toBe(true);
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

  it("recovers from prompt-too-long INVALID_REQUEST via reactive compact", async () => {
    let called = 0;
    const modelClient: ModelClient = {
      generate: async () => {
        called += 1;
        if (called === 1) {
          throw {
            code: "INVALID_REQUEST",
            rawType: "prompt_too_long",
            message: "prompt too long",
          };
        }
        return { type: "final", output: "Recovered" };
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

    const runtime = new AgentRuntime(buildRuntimeConfig({ modelClient }));
    const ctx = baseCtx();
    ctx.input.messages = buildInputMessages(12);

    const result = await runtime.run(ctx);
    expect(result.status).toBe("completed");
    expect(result.output).toBe("Recovered");
  });

  it("recovers from max_output_tokens INVALID_REQUEST via reactive compact", async () => {
    let called = 0;
    const modelClient: ModelClient = {
      generate: async () => {
        called += 1;
        if (called === 1) {
          throw {
            code: "INVALID_REQUEST",
            rawType: "max_output_tokens",
            message: "max output tokens exceeded",
          };
        }
        return { type: "final", output: "Recovered from output cap" };
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

    const runtime = new AgentRuntime(buildRuntimeConfig({ modelClient }));
    const ctx = baseCtx();
    ctx.input.messages = buildInputMessages(12);

    const result = await runtime.run(ctx);
    expect(result.status).toBe("completed");
    expect(result.output).toBe("Recovered from output cap");
  });

  it("recovers from context length INVALID_REQUEST via reactive compact", async () => {
    let called = 0;
    const modelClient: ModelClient = {
      generate: async () => {
        called += 1;
        if (called === 1) {
          throw {
            code: "INVALID_REQUEST",
            rawType: "context_length_exceeded",
            message: "context length exceeded",
          };
        }
        return { type: "final", output: "Recovered from context overflow" };
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

    const runtime = new AgentRuntime(buildRuntimeConfig({ modelClient }));
    const ctx = baseCtx();
    ctx.input.messages = buildInputMessages(12);

    const result = await runtime.run(ctx);
    expect(result.status).toBe("completed");
    expect(result.output).toBe("Recovered from context overflow");
  });

  it("recovers from media_too_large INVALID_REQUEST via reactive compact", async () => {
    let called = 0;
    const modelClient: ModelClient = {
      generate: async () => {
        called += 1;
        if (called === 1) {
          throw {
            code: "INVALID_REQUEST",
            rawType: "media_too_large",
            message: "media too large",
          };
        }
        return { type: "final", output: "Recovered from media limit" };
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

    const runtime = new AgentRuntime(buildRuntimeConfig({ modelClient }));
    const ctx = baseCtx();
    ctx.input.messages = buildInputMessages(12);

    const result = await runtime.run(ctx);
    expect(result.status).toBe("completed");
    expect(result.output).toBe("Recovered from media limit");
  });

  it("updates forked cache prefix after compact summary refine", async () => {
    let compactRefineCalled = false;
    const modelClient: ModelClient = {
      generate: async (request) => {
        if (request.metadata?.["compactRefine"]) {
          compactRefineCalled = true;
          return { type: "final", output: "refined summary", responseId: "resp_cache_prefix" };
        }
        return { type: "final", output: "ok" };
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

    const runtime = new AgentRuntime(
      buildRuntimeConfig({
        modelClient,
        context: {
          maxInputTokens: 100,
          maxOutputTokens: 100,
          maxPromptTooLongRetries: 3,
          maxReactiveCompactAttempts: 3,
          maxCompactRequestRetries: 2,
          compactRequestMaxInputChars: 20_000,
          maxConsecutiveCompactFailures: 3,
          toolResultSoftCharLimit: 6_000,
          historySnipKeepRounds: 2,
          historySnipMaxDropRounds: 1,
          microcompactMaxToolChars: 500,
          collapseRestoreMaxMessages: 8,
          collapseRestoreTokenHeadroomRatio: 0.6,
          rehydrationTokenBudget: 50_000,
          recentFileBudgetTokens: 5_000,
          skillsRehydrateBudgetTokens: 25_000,
          thresholds: {
            warningBufferTokens: 0,
            autoCompactBufferTokens: 0,
            errorBufferTokens: 0,
            blockingHeadroomTokens: -10_000,
          },
        },
      }),
    );

    const ctx = baseCtx();
    ctx.state.messages = [
      {
        id: "summary_seed",
        messageId: "summary_seed_msg",
        role: "system",
        content: "[Compact Summary:s1]\nseed summary",
        createdAt: new Date().toISOString(),
        source: "framework",
      },
    ];
    const result = await runtime.run(ctx);
    expect(result.status).toBe("completed");
    expect(compactRefineCalled).toBe(true);
    expect(result.state.context?.forkedCachePrefix).toBe("resp_cache_prefix");
  });

  it("degrades gracefully when compact summary refine fails", async () => {
    const modelClient: ModelClient = {
      generate: async (request) => {
        if (request.metadata?.["compactRefine"]) {
          throw new Error("refine failed");
        }
        return { type: "final", output: "main response ok" };
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

    const runtime = new AgentRuntime(buildRuntimeConfig({ modelClient }));
    const ctx = baseCtx();
    ctx.state.messages = [
      {
        id: "summary_seed",
        messageId: "summary_seed_msg",
        role: "system",
        content: "[Compact Summary:s1]\nseed summary",
        createdAt: new Date().toISOString(),
        source: "framework",
      },
    ];

    const result = await runtime.run(ctx);
    expect(result.status).toBe("completed");
    expect(result.output).toBe("main response ok");
  });

  it("injects context metadata into model request", async () => {
    let seenContextMetadata:
      | {
          apiViewId?: string;
          compactBoundaryId?: string;
          thresholdLevel?: "healthy" | "warning" | "auto_compact" | "error" | "blocking";
        }
      | undefined;

    const modelClient: ModelClient = {
      generate: async (request) => {
        seenContextMetadata = (
          request as {
            contextMetadata?: {
              apiViewId?: string;
              compactBoundaryId?: string;
              thresholdLevel?: "healthy" | "warning" | "auto_compact" | "error" | "blocking";
            };
          }
        ).contextMetadata;
        return { type: "final", output: "ok" };
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

    const runtime = new AgentRuntime(buildRuntimeConfig({ modelClient }));
    const result = await runtime.run(baseCtx({ inputText: "hello" }));

    expect(result.status).toBe("completed");
    expect(seenContextMetadata).toBeDefined();
    expect(seenContextMetadata?.apiViewId).toBeDefined();
    expect(seenContextMetadata?.thresholdLevel).toBeDefined();
  });

  it("does not call model when compact breaker is open", async () => {
    let called = 0;
    const modelClient: ModelClient = {
      generate: async () => {
        called += 1;
        return { type: "final", output: "should not happen" };
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

    const runtime = new AgentRuntime(
      buildRuntimeConfig({
        modelClient,
        context: {
          maxInputTokens: 1_000,
          maxOutputTokens: 100,
          maxPromptTooLongRetries: 3,
          maxReactiveCompactAttempts: 3,
          maxCompactRequestRetries: 2,
          compactRequestMaxInputChars: 20_000,
          maxConsecutiveCompactFailures: 3,
          toolResultSoftCharLimit: 6_000,
          historySnipKeepRounds: 50,
          historySnipMaxDropRounds: 10,
          microcompactMaxToolChars: 1_500,
          collapseRestoreMaxMessages: 8,
          collapseRestoreTokenHeadroomRatio: 0.6,
          rehydrationTokenBudget: 50_000,
          recentFileBudgetTokens: 5_000,
          skillsRehydrateBudgetTokens: 25_000,
          thresholds: {
            warningBufferTokens: 20_000,
            autoCompactBufferTokens: 13_000,
            errorBufferTokens: 20_000,
            blockingHeadroomTokens: 3_000,
          },
        },
      }),
    );
    const ctx = baseCtx({ inputText: "hello" });
    ctx.state.context = {
      roundIndex: 0,
      lastLayerExecutions: [],
      consecutiveCompactFailures: 3,
      promptTooLongRetries: 0,
      toolResultCache: {},
      preservedSegments: {},
      compactBoundaries: [],
    };

    const result = await runtime.run(ctx);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("CONTEXT_OVERFLOW");
    expect(called).toBe(0);
  });

  describe("stream()", () => {
    it("retries stream model failure on retryable error and succeeds", async () => {
      let streamCalled = 0;
      const modelClient: ModelClient = {
        generate: async () => ({ type: "final", output: "unused" }),
        stream: async function* () {
          streamCalled += 1;
          if (streamCalled === 1) {
            throw new AgentError({
              code: "MODEL_ERROR",
              message: "temporary stream failure",
              retryable: true,
            });
          }
          yield { type: "text_delta" as const, text: "stream ok" };
          yield { type: "done" as const };
        },
        resolve: () => ({
          logicalModel: "test",
          provider: "test",
          providerModel: "test",
        }),
      };
      const runtime = new AgentRuntime(buildRuntimeConfig({ modelClient }));
      const gen = runtime.stream(baseCtx({ inputText: "hello" }));
      let iter = await gen.next();
      while (!iter.done) {
        iter = await gen.next();
      }

      expect(iter.value.status).toBe("completed");
      expect(iter.value.output).toBe("stream ok");
      expect(streamCalled).toBe(2);
    });

    it("emits run lifecycle audit events in stream mode", async () => {
      const auditTypes: string[] = [];
      const modelClient = createMockModelClient([{ type: "final", output: "ok" }]);
      const runtime = new AgentRuntime(
        buildRuntimeConfig({
          modelClient,
          audit: {
            log: (event) => {
              auditTypes.push(event.type);
            },
          },
        }),
      );

      const gen = runtime.stream(baseCtx({ inputText: "hello" }));
      let iter = await gen.next();
      while (!iter.done) {
        iter = await gen.next();
      }

      expect(auditTypes).toContain("run_started");
      expect(auditTypes).toContain("run_completed");
    });

    it("calls afterRun with failed result in stream() catch branch", async () => {
      let afterRunCalled = false;
      let afterRunStatus: string | undefined;
      const pipeline = new MiddlewarePipeline([
        {
          name: "after-run-capture",
          afterRun: (_ctx, result) => {
            afterRunCalled = true;
            afterRunStatus = result.status;
          },
        },
      ]);
      const modelClient: ModelClient = {
        generate: async () => ({ type: "final", output: "unused" }),
        stream: async function* () {
          yield { type: "done" as const };
          throw new Error("stream crash");
        },
        resolve: () => ({
          logicalModel: "test",
          provider: "test",
          providerModel: "test",
        }),
      };

      const runtime = new AgentRuntime(buildRuntimeConfig({ modelClient, pipeline }));
      const stream = runtime.stream(baseCtx({ inputText: "hello" }));
      let iter = await stream.next();
      while (!iter.done) {
        iter = await stream.next();
      }

      expect(iter.value.status).toBe("failed");
      expect(afterRunCalled).toBe(true);
      expect(afterRunStatus).toBe("failed");
    });

    it("yields events and returns final result", async () => {
      const modelClient = createMockModelClient([{ type: "final", output: "Streamed response" }]);

      const runtime = new AgentRuntime(buildRuntimeConfig({ modelClient }));
      const ctx = baseCtx({ inputText: "Hi" });

      const events: string[] = [];
      let finalResult: AgentResult | undefined;

      const gen = runtime.stream(ctx);
      let iter = await gen.next();
      while (!iter.done) {
        events.push(iter.value.type);
        iter = await gen.next();
      }
      finalResult = iter.value;

      expect(events).toContain("run_started");
      expect(events).toContain("model_started");
      expect(events).toContain("assistant_delta");
      expect(events).toContain("run_completed");
      expect(finalResult.status).toBe("completed");
      expect(finalResult.output).toBe("Streamed response");
    });

    it("streams tool calls and tool results", async () => {
      const toolCalls: ToolCall[] = [{ id: "tc_1", name: "echo", input: { msg: "hi" } }];

      const modelClient = createMockModelClient([
        { type: "tool_calls", toolCalls },
        { type: "final", output: "After tool" },
      ]);

      const runtime = new AgentRuntime(buildRuntimeConfig({ modelClient, tools: [echoTool] }));

      const ctx = baseCtx({ inputText: "Use tool" });
      const events: string[] = [];

      const gen = runtime.stream(ctx);
      let iter = await gen.next();
      while (!iter.done) {
        events.push(iter.value.type);
        iter = await gen.next();
      }

      expect(events).toContain("tool_call");
      expect(events).toContain("tool_result");
      expect(events).toContain("run_completed");
    });

    it("run and stream should both block on context overflow threshold", async () => {
      const modelClient = createMockModelClient([{ type: "final", output: "never called" }]);
      const contextConfig = {
        maxInputTokens: 100,
        maxOutputTokens: 10,
        maxPromptTooLongRetries: 3,
        maxReactiveCompactAttempts: 3,
        maxCompactRequestRetries: 2,
        compactRequestMaxInputChars: 20_000,
        maxConsecutiveCompactFailures: 3,
        toolResultSoftCharLimit: 1000,
        historySnipKeepRounds: 50,
        historySnipMaxDropRounds: 10,
        microcompactMaxToolChars: 500,
        collapseRestoreMaxMessages: 8,
        collapseRestoreTokenHeadroomRatio: 0.6,
        rehydrationTokenBudget: 50_000,
        recentFileBudgetTokens: 5_000,
        skillsRehydrateBudgetTokens: 25_000,
        thresholds: {
          warningBufferTokens: 0,
          autoCompactBufferTokens: 0,
          errorBufferTokens: 0,
          blockingHeadroomTokens: 1_000,
        },
      };

      const runtimeRun = new AgentRuntime(
        buildRuntimeConfig({ modelClient, context: contextConfig }),
      );
      const runResult = await runtimeRun.run(baseCtx({ inputText: "x".repeat(1_000) }));
      expect(runResult.status).toBe("failed");
      expect(runResult.error?.code).toBe("CONTEXT_OVERFLOW");

      const runtimeStream = new AgentRuntime(
        buildRuntimeConfig({ modelClient, context: contextConfig }),
      );
      const streamEvents: string[] = [];
      const stream = runtimeStream.stream(baseCtx({ inputText: "x".repeat(1_000) }));
      let iter = await stream.next();
      while (!iter.done) {
        streamEvents.push(iter.value.type);
        iter = await stream.next();
      }
      expect(iter.value.status).toBe("failed");
      expect(iter.value.error?.code).toBe("CONTEXT_OVERFLOW");
      expect(streamEvents).toContain("run_started");
    });
  });
});

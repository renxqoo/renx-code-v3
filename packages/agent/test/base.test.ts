import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ModelClient, ModelResponse } from "@renx/model";

import { AgentBase } from "../src/base";
import { InMemoryTimelineStore } from "../src/timeline";
import type { AgentResult, AgentTool, RuntimeConfig, ToolResult } from "../src";
import { buildInput } from "./helpers";
import type { ApprovalEngine, TimelineNode } from "../src/types";

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

// --- Test Tool ---

const echoTool: AgentTool = {
  name: "echo",
  description: "Echoes input",
  schema: z.object({}).passthrough(),
  invoke: async (input: unknown): Promise<ToolResult> => ({
    content: JSON.stringify(input),
  }),
};

// --- Test Agent ---

class TestAgent extends AgentBase {
  constructor(
    private readonly client: ModelClient,
    private readonly timelineStore?: InMemoryTimelineStore,
    private readonly retryConfig?: RuntimeConfig["retry"],
  ) {
    super();
  }

  protected getName() {
    return "test-agent";
  }

  protected getSystemPrompt() {
    return "You are a test assistant.";
  }

  protected getTools() {
    return [echoTool];
  }

  protected getModelClient() {
    return this.client;
  }

  protected getModelName() {
    return "test-model";
  }

  protected getMaxSteps() {
    return 5;
  }

  protected getTimelineStore() {
    return this.timelineStore;
  }

  protected getRetryConfig() {
    return this.retryConfig;
  }
}

describe("AgentBase", () => {
  it("invokes and returns final response", async () => {
    const client = createMockModelClient([{ type: "final", output: "Hello from test agent!" }]);

    const agent = new TestAgent(client);
    const result = await agent.invoke(buildInput({ inputText: "Hi" }));

    expect(result.status).toBe("completed");
    expect(result.output).toBe("Hello from test agent!");
  });

  it("handles tool calls end-to-end", async () => {
    const client = createMockModelClient([
      {
        type: "tool_calls",
        toolCalls: [{ id: "tc_1", name: "echo", input: { msg: "hello" } }],
      },
      { type: "final", output: "I echoed your message." },
    ]);

    const agent = new TestAgent(client);
    const result = await agent.invoke(buildInput({ inputText: "Echo hello" }));

    expect(result.status).toBe("completed");
    expect(result.output).toBe("I echoed your message.");
    expect(result.state.messages.length).toBeGreaterThanOrEqual(3);
  });

  it("runs end-to-end with approval gate and resume", async () => {
    const approvalRequests: string[] = [];
    const approvalDecisions = new Map<string, "pending" | "approved" | "rejected" | "expired">();
    let gatedToolCalled = 0;

    const approvalEngine: ApprovalEngine = {
      evaluate: (_ctx, tool) => ({
        required: tool.name === "gated",
        reason: 'tool "gated" requires reviewer approval',
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
      description: "Tool requiring approval",
      schema: z.object({}).passthrough(),
      invoke: async (): Promise<ToolResult> => {
        gatedToolCalled += 1;
        return { content: "approved execution result" };
      },
    };

    class ApprovalE2EAgent extends AgentBase {
      constructor(
        private readonly modelClient: ModelClient,
        private readonly timelineStore: InMemoryTimelineStore,
        private readonly engine: ApprovalEngine,
      ) {
        super();
      }

      protected getName() {
        return "approval-e2e-agent";
      }

      protected getSystemPrompt() {
        return "You are an approval e2e test assistant.";
      }

      protected getTools() {
        return [gatedTool];
      }

      protected getModelClient() {
        return this.modelClient;
      }

      protected getModelName() {
        return "test-model";
      }

      protected getMaxSteps() {
        return 6;
      }

      protected getTimelineStore() {
        return this.timelineStore;
      }

      protected getApprovalEngine() {
        return this.engine;
      }
    }

    const timeline = new InMemoryTimelineStore();
    const modelClient = createMockModelClient([
      {
        type: "tool_calls",
        toolCalls: [{ id: "tc_gated_1", name: "gated", input: { op: "deploy" } }],
      },
      { type: "final", output: "Deployment approved and completed." },
    ]);
    const agent = new ApprovalE2EAgent(modelClient, timeline, approvalEngine);

    const first = await agent.invoke(buildInput({ inputText: "deploy now" }));
    expect(first.status).toBe("waiting_approval");
    expect(gatedToolCalled).toBe(0);
    expect(approvalRequests.length).toBe(1);

    const ticketId = approvalRequests[0]!;
    approvalDecisions.set(ticketId, "approved");

    const resumed = await agent.resume(first.runId);
    expect(resumed.status).toBe("completed");
    expect(resumed.output).toBe("Deployment approved and completed.");
    expect(gatedToolCalled).toBe(1);
    expect(
      resumed.state.messages.some((m) => m.role === "tool" && m.toolCallId === "tc_gated_1"),
    ).toBe(true);
  });

  it("streams end-to-end with approval gate then resume", async () => {
    const approvalRequests: string[] = [];
    const approvalDecisions = new Map<string, "pending" | "approved" | "rejected" | "expired">();
    let gatedToolCalled = 0;

    const approvalEngine: ApprovalEngine = {
      evaluate: (_ctx, tool) => ({
        required: tool.name === "gated",
        reason: 'tool "gated" requires reviewer approval',
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
      description: "Tool requiring approval",
      schema: z.object({}).passthrough(),
      invoke: async (): Promise<ToolResult> => {
        gatedToolCalled += 1;
        return { content: "approved execution result" };
      },
    };

    let generateCalls = 0;
    const modelClient: ModelClient = {
      generate: async () => {
        generateCalls += 1;
        if (generateCalls === 1) {
          return { type: "final", output: "resume completed" };
        }
        return { type: "final", output: "done" };
      },
      stream: async function* () {
        yield {
          type: "tool_call" as const,
          call: { id: "tc_stream_gated_1", name: "gated", input: { op: "deploy" } },
        };
        yield { type: "done" as const };
      },
      resolve: () => ({
        logicalModel: "test",
        provider: "test",
        providerModel: "test",
      }),
    };

    class ApprovalStreamE2EAgent extends AgentBase {
      constructor(
        private readonly client: ModelClient,
        private readonly timelineStore: InMemoryTimelineStore,
        private readonly engine: ApprovalEngine,
      ) {
        super();
      }

      protected getName() {
        return "approval-stream-e2e-agent";
      }
      protected getSystemPrompt() {
        return "You are an approval stream e2e test assistant.";
      }
      protected getTools() {
        return [gatedTool];
      }
      protected getModelClient() {
        return this.client;
      }
      protected getModelName() {
        return "test-model";
      }
      protected getMaxSteps() {
        return 6;
      }
      protected getTimelineStore() {
        return this.timelineStore;
      }
      protected getApprovalEngine() {
        return this.engine;
      }
    }

    const timeline = new InMemoryTimelineStore();
    const agent = new ApprovalStreamE2EAgent(modelClient, timeline, approvalEngine);

    const streamEvents: string[] = [];
    const iter = agent.stream(buildInput({ inputText: "deploy by stream" }));
    let streamResult: AgentResult | undefined;
    while (true) {
      const next = await iter.next();
      if (next.done) {
        streamResult = next.value;
        break;
      }
      streamEvents.push(next.value.type);
    }

    expect(streamEvents).toContain("run_started");
    expect(streamEvents).toContain("model_started");
    expect(streamResult).toBeDefined();
    expect(streamResult!.status).toBe("waiting_approval");
    expect(gatedToolCalled).toBe(0);
    expect(approvalRequests.length).toBe(1);

    const ticketId = approvalRequests[0]!;
    approvalDecisions.set(ticketId, "approved");

    const resumed = await agent.resume(streamResult!.runId);
    expect(resumed.status).toBe("completed");
    expect(resumed.output).toBe("resume completed");
    expect(gatedToolCalled).toBe(1);
    expect(
      resumed.state.messages.some((m) => m.role === "tool" && m.toolCallId === "tc_stream_gated_1"),
    ).toBe(true);
  });

  it("streams end-to-end fails when approval is rejected on resume", async () => {
    const approvalRequests: string[] = [];
    const approvalDecisions = new Map<string, "pending" | "approved" | "rejected" | "expired">();
    let gatedToolCalled = 0;

    const approvalEngine: ApprovalEngine = {
      evaluate: (_ctx, tool) => ({
        required: tool.name === "gated",
        reason: 'tool "gated" requires reviewer approval',
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
          reviewerId: "reviewer-reject",
          ...(status === "rejected" ? { comment: "not allowed" } : {}),
          decidedAt: new Date().toISOString(),
        };
      },
    };

    const gatedTool: AgentTool = {
      name: "gated",
      description: "Tool requiring approval",
      schema: z.object({}).passthrough(),
      invoke: async (): Promise<ToolResult> => {
        gatedToolCalled += 1;
        return { content: "should not execute when rejected" };
      },
    };

    const modelClient: ModelClient = {
      generate: async () => ({ type: "final", output: "should not complete" }),
      stream: async function* () {
        yield {
          type: "tool_call" as const,
          call: { id: "tc_stream_gated_reject_1", name: "gated", input: { op: "dangerous-op" } },
        };
        yield { type: "done" as const };
      },
      resolve: () => ({
        logicalModel: "test",
        provider: "test",
        providerModel: "test",
      }),
    };

    class ApprovalStreamRejectE2EAgent extends AgentBase {
      constructor(
        private readonly client: ModelClient,
        private readonly timelineStore: InMemoryTimelineStore,
        private readonly engine: ApprovalEngine,
      ) {
        super();
      }
      protected getName() {
        return "approval-stream-reject-e2e-agent";
      }
      protected getSystemPrompt() {
        return "You are an approval stream reject e2e test assistant.";
      }
      protected getTools() {
        return [gatedTool];
      }
      protected getModelClient() {
        return this.client;
      }
      protected getModelName() {
        return "test-model";
      }
      protected getMaxSteps() {
        return 6;
      }
      protected getTimelineStore() {
        return this.timelineStore;
      }
      protected getApprovalEngine() {
        return this.engine;
      }
    }

    const timeline = new InMemoryTimelineStore();
    const agent = new ApprovalStreamRejectE2EAgent(modelClient, timeline, approvalEngine);

    const iter = agent.stream(buildInput({ inputText: "run dangerous stream op" }));
    let firstResult: AgentResult | undefined;
    while (true) {
      const next = await iter.next();
      if (next.done) {
        firstResult = next.value;
        break;
      }
    }

    expect(firstResult).toBeDefined();
    expect(firstResult!.status).toBe("waiting_approval");
    expect(gatedToolCalled).toBe(0);
    expect(approvalRequests.length).toBe(1);

    const ticketId = approvalRequests[0]!;
    approvalDecisions.set(ticketId, "rejected");

    const resumed = await agent.resume(firstResult!.runId);
    expect(resumed.status).toBe("failed");
    expect(resumed.error?.code).toBe("APPROVAL_REQUIRED");
    expect(gatedToolCalled).toBe(0);
    expect(
      resumed.state.messages.some(
        (m) => m.role === "assistant" && m.content.includes("approval rejected"),
      ),
    ).toBe(true);
  });

  it("resumes from timeline snapshot", async () => {
    const timeline = new InMemoryTimelineStore();
    const client = createMockModelClient([{ type: "final", output: "Resumed and done!" }]);

    const agent = new TestAgent(client, timeline);

    // First run
    const firstResult = await agent.invoke(buildInput({ inputText: "Hi" }));
    expect(firstResult.status).toBe("completed");

    // Resume
    const resumed = await agent.resume(firstResult.runId);
    expect(resumed.status).toBe("completed");
  });

  it("throws when timeline snapshot not found for resume", async () => {
    const timeline = new InMemoryTimelineStore();
    const client = createMockModelClient([]);
    const agent = new TestAgent(client, timeline);

    await expect(agent.resume("nonexistent")).rejects.toThrow("Timeline snapshot not found");
  });

  it("throws when no timeline store configured for resume", async () => {
    const client = createMockModelClient([]);
    const agent = new TestAgent(client);

    await expect(agent.resume("any-id")).rejects.toThrow("TimelineStore is required");
  });

  it("resume projects API view from latest compact boundary", async () => {
    let observedMessageIds: string[] = [];
    const modelClient: ModelClient = {
      generate: async (request) => {
        observedMessageIds = request.messages.map((m) => m.id);
        return { type: "final", output: "resumed" };
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

    const timeline = new InMemoryTimelineStore();
    const runId = "run_resume_boundary";
    const record: TimelineNode = {
      nodeId: "node_latest",
      runId,
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: {
        runId,
        status: "running",
        stepCount: 0,
        scratchpad: {},
        memory: {},
        messages: [
          {
            id: "old_1",
            messageId: "old_1_msg",
            role: "user",
            content: "old",
            createdAt: new Date().toISOString(),
            source: "input",
          },
          {
            id: "boundary",
            messageId: "boundary_msg",
            role: "system",
            content: "[Compact Boundary]",
            createdAt: new Date().toISOString(),
            source: "framework",
            compactBoundary: {
              boundaryId: "b1",
              strategy: "auto_compact",
              createdAt: new Date().toISOString(),
            },
          },
          {
            id: "tail_1",
            messageId: "tail_1_msg",
            role: "assistant",
            content: "tail",
            createdAt: new Date().toISOString(),
            source: "model",
          },
        ],
        context: {
          roundIndex: 0,
          lastLayerExecutions: [],
          consecutiveCompactFailures: 0,
          promptTooLongRetries: 0,
          toolResultCache: {},
          preservedSegments: {},
          compactBoundaries: [],
        },
      },
    };
    await timeline.save(record);

    const agent = new TestAgent(modelClient, timeline);
    const result = await agent.resume(runId);

    expect(result.status).toBe("completed");
    expect(observedMessageIds).toContain("boundary");
    expect(observedMessageIds).toContain("tail_1");
    expect(observedMessageIds).not.toContain("old_1");
  });

  it("resumeAt resumes from specified historical node", async () => {
    let observedMessageIds: string[] = [];
    const modelClient: ModelClient = {
      generate: async (request) => {
        observedMessageIds = request.messages.map((m) => m.id);
        return { type: "final", output: "resumed-at-node" };
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

    const timeline = new InMemoryTimelineStore();
    const runId = "run_resume_at";

    await timeline.save({
      nodeId: "node_1",
      runId,
      version: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: {
        runId,
        status: "running",
        stepCount: 0,
        scratchpad: {},
        memory: {},
        messages: [
          {
            id: "history_1",
            messageId: "history_1_msg",
            role: "user",
            content: "from-node-1",
            createdAt: new Date().toISOString(),
            source: "input",
          },
        ],
        context: {
          roundIndex: 0,
          lastLayerExecutions: [],
          consecutiveCompactFailures: 0,
          promptTooLongRetries: 0,
          toolResultCache: {},
          preservedSegments: {},
          compactBoundaries: [],
        },
      },
    });

    await timeline.save({
      nodeId: "node_2",
      parentNodeId: "node_1",
      runId,
      version: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: {
        runId,
        status: "running",
        stepCount: 0,
        scratchpad: {},
        memory: {},
        messages: [
          {
            id: "history_2",
            messageId: "history_2_msg",
            role: "user",
            content: "from-node-2",
            createdAt: new Date().toISOString(),
            source: "input",
          },
        ],
        context: {
          roundIndex: 0,
          lastLayerExecutions: [],
          consecutiveCompactFailures: 0,
          promptTooLongRetries: 0,
          toolResultCache: {},
          preservedSegments: {},
          compactBoundaries: [],
        },
      },
    });

    const agent = new TestAgent(modelClient, timeline);
    const result = await agent.resumeAt(runId, "node_1");

    expect(result.status).toBe("completed");
    expect(observedMessageIds).toContain("history_1");
    expect(observedMessageIds).not.toContain("history_2");
  });

  it("resumeAt read_only_preview does not mutate timeline head", async () => {
    const modelClient = createMockModelClient([{ type: "final", output: "preview-only" }]);
    const timeline = new InMemoryTimelineStore();
    const runId = "run_preview";

    await timeline.save({
      nodeId: "node_1",
      runId,
      version: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: {
        runId,
        status: "running",
        stepCount: 0,
        scratchpad: {},
        memory: {},
        messages: [],
        context: {
          roundIndex: 0,
          lastLayerExecutions: [],
          consecutiveCompactFailures: 0,
          promptTooLongRetries: 0,
          toolResultCache: {},
          preservedSegments: {},
          compactBoundaries: [],
        },
      },
    });
    await timeline.save({
      nodeId: "node_2",
      parentNodeId: "node_1",
      runId,
      version: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: {
        runId,
        status: "running",
        stepCount: 0,
        scratchpad: {},
        memory: {},
        messages: [],
        context: {
          roundIndex: 0,
          lastLayerExecutions: [],
          consecutiveCompactFailures: 0,
          promptTooLongRetries: 0,
          toolResultCache: {},
          preservedSegments: {},
          compactBoundaries: [],
        },
      },
    });

    const beforeHead = await timeline.load(runId);
    const beforeCount = (await timeline.listNodes(runId)).length;
    const agent = new TestAgent(modelClient, timeline);
    const result = await agent.resumeAt(runId, "node_1", { mode: "read_only_preview" });
    const afterHead = await timeline.load(runId);
    const afterCount = (await timeline.listNodes(runId)).length;

    expect(result.status).toBe("completed");
    expect(beforeHead?.nodeId).toBe("node_2");
    expect(afterHead?.nodeId).toBe("node_2");
    expect(afterCount).toBe(beforeCount);
  });

  it("resumeAt blocks irreversible tools by default", async () => {
    const modelClient = createMockModelClient([
      {
        type: "tool_calls",
        toolCalls: [{ id: "tc_1", name: "echo", input: { msg: "mutate" } }],
      },
    ]);
    const timeline = new InMemoryTimelineStore();
    const runId = "run_resume_at_guard";
    await timeline.save({
      nodeId: "node_1",
      runId,
      version: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: {
        runId,
        status: "running",
        stepCount: 0,
        scratchpad: {},
        memory: {},
        messages: [],
        context: {
          roundIndex: 0,
          lastLayerExecutions: [],
          consecutiveCompactFailures: 0,
          promptTooLongRetries: 0,
          toolResultCache: {},
          preservedSegments: {},
          compactBoundaries: [],
        },
      },
    });

    const agent = new TestAgent(modelClient, timeline);
    const result = await agent.resumeAt(runId, "node_1");
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("POLICY_DENIED");
  });

  it("resumeAt fast_forward re-anchors head to target lineage", async () => {
    const modelClient = createMockModelClient([{ type: "final", output: "ff-done" }]);
    const timeline = new InMemoryTimelineStore();
    const runId = "run_resume_at_fast_forward";

    await timeline.save({
      nodeId: "node_1",
      runId,
      version: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: {
        runId,
        status: "running",
        stepCount: 0,
        scratchpad: {},
        memory: {},
        messages: [],
        context: {
          roundIndex: 0,
          lastLayerExecutions: [],
          consecutiveCompactFailures: 0,
          promptTooLongRetries: 0,
          toolResultCache: {},
          preservedSegments: {},
          compactBoundaries: [],
        },
      },
    });
    await timeline.save({
      nodeId: "node_2",
      parentNodeId: "node_1",
      runId,
      version: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: {
        runId,
        status: "running",
        stepCount: 0,
        scratchpad: {},
        memory: {},
        messages: [],
        context: {
          roundIndex: 0,
          lastLayerExecutions: [],
          consecutiveCompactFailures: 0,
          promptTooLongRetries: 0,
          toolResultCache: {},
          preservedSegments: {},
          compactBoundaries: [],
        },
      },
    });
    await timeline.save({
      nodeId: "node_3",
      parentNodeId: "node_2",
      runId,
      version: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: {
        runId,
        status: "running",
        stepCount: 0,
        scratchpad: {},
        memory: {},
        messages: [],
        context: {
          roundIndex: 0,
          lastLayerExecutions: [],
          consecutiveCompactFailures: 0,
          promptTooLongRetries: 0,
          toolResultCache: {},
          preservedSegments: {},
          compactBoundaries: [],
        },
      },
    });

    const beforeHead = await timeline.load(runId);
    const agent = new TestAgent(modelClient, timeline);
    const result = await agent.resumeAt(runId, "node_1", { mode: "fast_forward" });
    const afterHead = await timeline.load(runId);

    expect(result.status).toBe("completed");
    expect(beforeHead?.nodeId).toBe("node_3");
    expect(afterHead?.nodeId).not.toBe("node_3");
  });

  it("resumeAt fast_forward rejects off-head-lineage target", async () => {
    const modelClient = createMockModelClient([{ type: "final", output: "unused" }]);
    const timeline = new InMemoryTimelineStore();
    const runId = "run_resume_at_ff_guard";

    await timeline.save({
      nodeId: "node_1",
      runId,
      version: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: {
        runId,
        status: "running",
        stepCount: 0,
        scratchpad: {},
        memory: {},
        messages: [],
        context: {
          roundIndex: 0,
          lastLayerExecutions: [],
          consecutiveCompactFailures: 0,
          promptTooLongRetries: 0,
          toolResultCache: {},
          preservedSegments: {},
          compactBoundaries: [],
        },
      },
    });
    await timeline.save({
      nodeId: "node_2",
      parentNodeId: "node_1",
      runId,
      version: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: {
        runId,
        status: "running",
        stepCount: 0,
        scratchpad: {},
        memory: {},
        messages: [],
        context: {
          roundIndex: 0,
          lastLayerExecutions: [],
          consecutiveCompactFailures: 0,
          promptTooLongRetries: 0,
          toolResultCache: {},
          preservedSegments: {},
          compactBoundaries: [],
        },
      },
    });
    await timeline.save({
      nodeId: "node_side",
      parentNodeId: "node_1",
      runId,
      version: 0,
      metadata: { __timelineInternalMode: "fork" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: {
        runId,
        status: "running",
        stepCount: 0,
        scratchpad: {},
        memory: {},
        messages: [],
        context: {
          roundIndex: 0,
          lastLayerExecutions: [],
          consecutiveCompactFailures: 0,
          promptTooLongRetries: 0,
          toolResultCache: {},
          preservedSegments: {},
          compactBoundaries: [],
        },
      },
    });
    await timeline.save({
      nodeId: "node_3",
      parentNodeId: "node_2",
      runId,
      version: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: {
        runId,
        status: "running",
        stepCount: 0,
        scratchpad: {},
        memory: {},
        messages: [],
        context: {
          roundIndex: 0,
          lastLayerExecutions: [],
          consecutiveCompactFailures: 0,
          promptTooLongRetries: 0,
          toolResultCache: {},
          preservedSegments: {},
          compactBoundaries: [],
        },
      },
    });

    const agent = new TestAgent(modelClient, timeline);
    await expect(agent.resumeAt(runId, "node_side", { mode: "fast_forward" })).rejects.toThrow(
      "fast_forward requires target node on head lineage",
    );
  });

  it("passes retry config from base to runtime", async () => {
    let called = 0;
    const flakyClient: ModelClient = {
      generate: async () => {
        called += 1;
        if (called === 1) {
          throw { code: "MODEL_ERROR", message: "temp", retryable: true };
        }
        return { type: "final", output: "Recovered from base retry config" };
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

    const agent = new TestAgent(flakyClient, undefined, {
      modelMaxRetries: 2,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 2,
    });
    const result = await agent.invoke(buildInput({ inputText: "retry" }));

    expect(result.status).toBe("completed");
    expect(result.output).toBe("Recovered from base retry config");
    expect(called).toBe(2);
  });
});

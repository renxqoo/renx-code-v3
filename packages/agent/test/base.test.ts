import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ModelClient, ModelResponse } from "@renx/model";

import { EnterpriseAgentBase } from "../src/base";
import { InMemoryCheckpointStore } from "../src/checkpoint";
import type { AgentTool, RuntimeConfig, ToolResult } from "../src";
import { buildInput } from "./helpers";
import type { CheckpointRecord } from "../src/types";

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

class TestAgent extends EnterpriseAgentBase {
  constructor(
    private readonly client: ModelClient,
    private readonly checkpointStore?: InMemoryCheckpointStore,
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

  protected getCheckpointStore() {
    return this.checkpointStore;
  }

  protected getRetryConfig() {
    return this.retryConfig;
  }
}

describe("EnterpriseAgentBase", () => {
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

  it("resumes from checkpoint", async () => {
    const checkpoint = new InMemoryCheckpointStore();
    const client = createMockModelClient([{ type: "final", output: "Resumed and done!" }]);

    const agent = new TestAgent(client, checkpoint);

    // First run
    const firstResult = await agent.invoke(buildInput({ inputText: "Hi" }));
    expect(firstResult.status).toBe("completed");

    // Resume
    const resumed = await agent.resume(firstResult.runId);
    expect(resumed.status).toBe("completed");
  });

  it("throws when checkpoint not found for resume", async () => {
    const checkpoint = new InMemoryCheckpointStore();
    const client = createMockModelClient([]);
    const agent = new TestAgent(client, checkpoint);

    await expect(agent.resume("nonexistent")).rejects.toThrow("Checkpoint not found");
  });

  it("throws when no checkpoint store configured for resume", async () => {
    const client = createMockModelClient([]);
    const agent = new TestAgent(client);

    await expect(agent.resume("any-id")).rejects.toThrow("CheckpointStore is required");
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

    const checkpoint = new InMemoryCheckpointStore();
    const runId = "run_resume_boundary";
    const record: CheckpointRecord = {
      runId,
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
    await checkpoint.save(record);

    const agent = new TestAgent(modelClient, checkpoint);
    const result = await agent.resume(runId);

    expect(result.status).toBe("completed");
    expect(observedMessageIds).toContain("boundary");
    expect(observedMessageIds).toContain("tail_1");
    expect(observedMessageIds).not.toContain("old_1");
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

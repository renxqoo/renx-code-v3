import { describe, expect, it } from "vitest";

import type { ModelClient, ModelResponse } from "@renx/model";

import { EnterpriseAgentBase } from "../src/base";
import { InMemoryCheckpointStore } from "../src/checkpoint";
import type { AgentTool, ToolResult } from "../src";
import { buildInput } from "./helpers";

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
  invoke: async (input: unknown): Promise<ToolResult> => ({
    content: JSON.stringify(input),
  }),
};

// --- Test Agent ---

class TestAgent extends EnterpriseAgentBase {
  constructor(
    private readonly client: ModelClient,
    private readonly checkpointStore?: InMemoryCheckpointStore,
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
});

import { describe, expect, it } from "vitest";

import type { ModelClient } from "@renx/model";

import { AgentRuntime } from "../../src/runtime";
import { createMemorySnapshot, type MemorySubsystem } from "../../src/memory";
import { baseCtx } from "../helpers";

describe("memory runtime recall integration", () => {
  it("uses recall metadata to inject only relevant semantic memories into the prompt", async () => {
    let observedPrompt = "";
    const memory: MemorySubsystem = {
      store: {
        load: async () =>
          createMemorySnapshot({
            semantic: {
              entries: [
                {
                  id: "feedback:test-policy",
                  type: "feedback",
                  title: "Testing policy",
                  content: "Integration tests must hit the real database.",
                  why: "Mocks hid a migration failure.",
                  updatedAt: "2026-04-05T03:00:00.000Z",
                  tags: ["test", "database"],
                },
                {
                  id: "reference:dashboard",
                  type: "reference",
                  title: "Latency dashboard",
                  content: "grafana.internal/d/api-latency is the board oncall watches.",
                  updatedAt: "2026-04-05T02:00:00.000Z",
                  tags: ["grafana", "latency"],
                },
              ],
            },
          }),
        save: async () => {},
      },
    };
    const modelClient: ModelClient = {
      generate: async (request) => {
        observedPrompt = request.messages.map((message) => String(message.content)).join("\n");
        return { type: "final", output: "done" };
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

    const runtime = new AgentRuntime({
      name: "memory-runtime-recall-test",
      modelClient,
      model: "test-model",
      tools: [],
      systemPrompt: "You are helpful.",
      maxSteps: 3,
      memory,
    });

    const ctx = baseCtx({ inputText: "Should I mock the database in tests?" });
    ctx.metadata = {
      memoryQuery: "database test policy",
      explicitMemoryRecall: true,
    };

    const result = await runtime.run(ctx);

    expect(result.status).toBe("completed");
    expect(observedPrompt).toContain("Integration tests must hit the real database.");
    expect(observedPrompt).not.toContain("grafana.internal/d/api-latency");
  });
});

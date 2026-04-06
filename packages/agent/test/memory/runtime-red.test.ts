import { describe, expect, it } from "vitest";

import type { ModelClient } from "@renx/model";

import { AgentRuntime } from "../../src/runtime";
import { initialContextRuntimeState } from "../../src/context";
import { createMemorySnapshot, type MemorySnapshot, type MemorySubsystem } from "../../src/memory";
import { baseCtx } from "../helpers";

describe("memory runtime integration", () => {
  it("hydrates the persisted layered memory snapshot before the model turn and saves the enriched snapshot after the run", async () => {
    let storedSnapshot: MemorySnapshot | null = createMemorySnapshot({
      working: {
        activePlan: "complete the memory refactor",
        recentFiles: [
          {
            path: "src/base.ts",
            content: "export abstract class AgentBase {}",
            updatedAt: "2026-04-05T00:00:00.000Z",
          },
        ],
      },
      semantic: {
        entries: [
          {
            id: "project:mode",
            title: "Implementation mode",
            content: "Always write red tests first.",
            updatedAt: "2026-04-05T00:00:00.000Z",
          },
        ],
      },
    });
    const savedSnapshots: MemorySnapshot[] = [];
    let observedPrompt = "";

    const memory: MemorySubsystem = {
      store: {
        load: async () => storedSnapshot,
        save: async (_runId: string, snapshot: MemorySnapshot) => {
          storedSnapshot = snapshot;
          savedSnapshots.push(snapshot);
        },
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
      name: "memory-runtime-test",
      modelClient,
      model: "test-model",
      tools: [],
      systemPrompt: "You are helpful.",
      maxSteps: 3,
      memory,
    });

    const ctx = baseCtx({ inputText: "continue the implementation" });
    ctx.state.context = {
      ...initialContextRuntimeState(),
      sessionMemoryState: {
        notes:
          "# Session Title\n_Test_\n\n# Current State\n_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._\nImplementing the new memory runtime.",
        initialized: true,
        tokensAtLastExtraction: 120,
      },
      preservedContextAssets: {
        "custom:carry": {
          id: "custom:carry",
          kind: "custom",
          title: "Carry note",
          content: "reinject after compact",
          updatedAt: "2026-04-05T02:00:00.000Z",
        },
      },
    };

    const result = await runtime.run(ctx);

    const resolvedSnapshot = createMemorySnapshot(result.state.memory);

    expect(result.status).toBe("completed");
    expect(resolvedSnapshot.working.activePlan).toBe("complete the memory refactor");
    expect(observedPrompt).toContain("complete the memory refactor");
    expect(observedPrompt).toContain("Always write red tests first.");
    expect(savedSnapshots.length).toBeGreaterThan(0);
    expect(savedSnapshots.at(-1)?.session?.notes).toContain("Implementing the new memory runtime.");
    expect(savedSnapshots.at(-1)?.artifacts?.preservedContextAssets?.[0]?.id).toBe("custom:carry");
  });
});

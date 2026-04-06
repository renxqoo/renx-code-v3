import { describe, expect, it } from "vitest";

import type { ModelClient } from "@renx/model";

import { AgentBase } from "../../src/base";
import { InMemoryTimelineStore } from "../../src/timeline";
import { createMemorySnapshot, InMemoryMemoryStore, type MemorySubsystem } from "../../src/memory";
import { buildInput } from "../helpers";

describe("AgentBase memory API", () => {
  it("exposes a durable public memory snapshot API backed by the memory subsystem", async () => {
    const timeline = new InMemoryTimelineStore();
    const memoryStore = new InMemoryMemoryStore();
    const modelClient: ModelClient = {
      generate: async () => ({ type: "final", output: "done" }),
      stream: async function* () {
        yield { type: "done" as const };
      },
      resolve: () => ({
        logicalModel: "test",
        provider: "test",
        providerModel: "test",
      }),
    };

    class MemoryAgent extends AgentBase {
      protected getName() {
        return "memory-agent";
      }

      protected getSystemPrompt() {
        return "You are a memory-enabled test agent.";
      }

      protected getTools() {
        return [];
      }

      protected getModelClient() {
        return modelClient;
      }

      protected getModelName() {
        return "test-model";
      }

      protected getTimelineStore() {
        return timeline;
      }

      protected getMemory(): MemorySubsystem {
        return {
          store: memoryStore,
        };
      }
    }

    const agent = new MemoryAgent();
    const result = await agent.invoke(buildInput({ inputText: "ship the memory subsystem" }));

    await memoryStore.save(
      result.runId,
      createMemorySnapshot({
        working: {
          activePlan: "finish memory implementation",
        },
        semantic: {
          entries: [
            {
              id: "project:goal",
              content: "This is an enterprise agent SDK.",
              updatedAt: "2026-04-05T00:00:00.000Z",
            },
          ],
        },
      }),
    );

    const snapshot = createMemorySnapshot(await agent.loadMemorySnapshot(result.runId));

    expect(snapshot.working.activePlan).toBe("finish memory implementation");
    expect(snapshot.semantic.entries[0]?.content).toContain("enterprise agent SDK");
  });
});

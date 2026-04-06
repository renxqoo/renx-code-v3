import { describe, expect, it } from "vitest";

import type { ModelClient } from "@renx/model";

import { AgentRuntime } from "../../src/runtime";
import {
  createMemorySnapshot,
  MemoryService,
  type MemorySnapshot,
  type MemorySubsystem,
} from "../../src/memory";
import { baseCtx } from "../helpers";

describe("memory automation", () => {
  it("auto-saves extracted semantic memories into scoped storage and emits memory events", async () => {
    const events: string[] = [];
    const scopedSnapshots = new Map<string, MemorySnapshot>();
    let extractorCalls = 0;
    let runSnapshot: MemorySnapshot | null = createMemorySnapshot();

    const memory: MemorySubsystem = {
      store: {
        load: async () => runSnapshot,
        save: async (_runId, snapshot) => {
          runSnapshot = snapshot;
        },
      },
      scopeStore: {
        load: async (scope, namespace) => scopedSnapshots.get(`${scope}:${namespace}`) ?? null,
        save: async (scope, namespace, snapshot) => {
          scopedSnapshots.set(`${scope}:${namespace}`, snapshot);
        },
      },
      scopeResolver: ({ tenantId, userId, metadata }) => ({
        user: `${tenantId}:${userId}`,
        project: String(metadata?.["projectMemoryKey"] ?? ""),
      }),
      extractor: {
        extract: async ({ conversation }) => {
          extractorCalls += 1;
          return {
            entries: [
              {
                id: "feedback:testing-policy",
                type: "feedback",
                title: "Testing policy",
                content: `Do not mock the database. Evidence: ${conversation[0]?.content ?? ""}`,
                why: "Mocks previously hid production regressions.",
                howToApply: "Use a real test database.",
                updatedAt: "2026-04-05T12:00:00.000Z",
                scope: "project",
              },
            ],
          };
        },
      },
      automation: {
        minimumMessages: 2,
        maxConversationMessages: 8,
        targetScope: "project",
      },
      hooks: {
        onEvent: async (event) => {
          events.push(event.type);
        },
      },
    };

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

    const runtime = new AgentRuntime({
      name: "memory-automation-test",
      modelClient,
      model: "test-model",
      tools: [],
      systemPrompt: "You are helpful.",
      maxSteps: 3,
      memory,
    });

    const ctx = baseCtx({
      inputText: "Do not mock the database in these tests; use the real DB.",
    });
    ctx.identity = { userId: "user-a", tenantId: "tenant-a", roles: [] };
    ctx.metadata = { projectMemoryKey: "tenant-a/repo-a" };

    const result = await runtime.run(ctx);

    expect(result.status).toBe("completed");
    expect(extractorCalls).toBe(1);
    expect(events).toContain("memory_auto_save_started");
    expect(events).toContain("memory_scope_persisted");
    expect(events).toContain("memory_auto_save_completed");
    expect(
      createMemorySnapshot(scopedSnapshots.get("project:tenant-a/repo-a") ?? undefined).semantic
        .entries[0]?.id,
    ).toBe("feedback:testing-policy");
  });

  it("skips duplicate auto-save work when the latest message was already processed", async () => {
    const events: string[] = [];
    let extractorCalls = 0;
    const subsystem: MemorySubsystem = {
      store: {
        load: async () => null,
        save: async () => {},
      },
      scopeStore: {
        load: async () => null,
        save: async () => {},
      },
      extractor: {
        extract: async () => {
          extractorCalls += 1;
          return {
            entries: [
              {
                id: "project:test",
                type: "project",
                content: "test",
                updatedAt: "2026-04-05T12:00:00.000Z",
              },
            ],
          };
        },
      },
      automation: {
        minimumMessages: 2,
        maxConversationMessages: 8,
        targetScope: "project",
      },
      hooks: {
        onEvent: async (event) => {
          events.push(event.type);
        },
      },
    };
    const service = new MemoryService(subsystem);
    const state = {
      ...baseCtx({ inputText: "Keep tests integration-only." }).state,
      messages: [
        {
          id: "m_1",
          messageId: "m_1",
          role: "user" as const,
          content: "Keep tests integration-only.",
          createdAt: "2026-04-05T12:00:00.000Z",
          source: "input" as const,
        },
        {
          id: "m_2",
          messageId: "m_2",
          role: "assistant" as const,
          content: "Understood.",
          createdAt: "2026-04-05T12:00:01.000Z",
          source: "model" as const,
        },
      ],
      memory: createMemorySnapshot({
        automation: {
          lastAutoSavedMessageId: "m_2",
        },
      }),
    };

    const nextState = await service.maybeAutoSave(state.runId, state, {
      runId: state.runId,
      userId: "user-a",
      tenantId: "tenant-a",
      metadata: { projectMemoryKey: "tenant-a/repo-a" },
    });

    expect(extractorCalls).toBe(0);
    expect(nextState.memory["automation"]).toEqual({ lastAutoSavedMessageId: "m_2" });
    expect(events).toContain("memory_auto_save_skipped");
  });
});

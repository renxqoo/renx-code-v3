import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ModelClient } from "@renx/model";

import { AgentRuntime } from "../../src/runtime";
import { createMemorySnapshot, type MemorySnapshot, type MemorySubsystem } from "../../src/memory";
import { baseCtx } from "../helpers";
import type { AgentTool, ToolResult } from "../../src/tool/types";

describe("memory scoped runtime integration", () => {
  it("hydrates scoped memory into the prompt and persists scoped entries back to their namespace", async () => {
    let observedPrompt = "";
    let generateCalls = 0;
    let runSnapshot: MemorySnapshot | null = createMemorySnapshot({
      working: {
        activePlan: "Finish the SDK memory foundation.",
      },
    });
    const scopedSnapshots = new Map<string, MemorySnapshot>();
    scopedSnapshots.set(
      "user:tenant-a:user-a",
      createMemorySnapshot({
        semantic: {
          entries: [
            {
              id: "user:style",
              title: "Response style",
              content: "Keep responses terse.",
              updatedAt: "2026-04-05T01:00:00.000Z",
              scope: "user",
            },
          ],
        },
      }),
    );
    scopedSnapshots.set(
      "project:tenant-a/repo-a",
      createMemorySnapshot({
        working: {
          rules: [
            {
              name: "project-rule",
              content: "Always write red tests first.",
              updatedAt: "2026-04-05T01:00:00.000Z",
              scope: "project",
            },
          ],
        },
      }),
    );

    const memoryPatchTool: AgentTool = {
      name: "remember-project",
      description: "Persists project memory",
      schema: z.object({}).passthrough(),
      invoke: async (): Promise<ToolResult> => ({
        content: "stored",
        statePatch: {
          mergeMemory: {
            semantic: {
              entries: [
                {
                  id: "project:new",
                  title: "Project invariant",
                  content: "Never add compatibility branches to the SDK memory subsystem.",
                  updatedAt: "2026-04-05T03:00:00.000Z",
                  scope: "project",
                },
              ],
            },
          },
        },
      }),
    };

    const modelClient: ModelClient = {
      generate: async (request) => {
        generateCalls += 1;
        observedPrompt = request.messages.map((message) => String(message.content)).join("\n");
        if (!observedPrompt.includes("Always write red tests first.")) {
          return { type: "final", output: "missing scoped memory" };
        }
        if (generateCalls === 1) {
          return {
            type: "tool_calls",
            toolCalls: [{ id: "tc_scope_1", name: "remember-project", input: {} }],
          };
        }
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
      scopeResolver: ({ userId, tenantId, metadata }) => ({
        user: `${tenantId}:${userId}`,
        project: String(metadata?.["projectMemoryKey"] ?? ""),
      }),
    };

    const runtime = new AgentRuntime({
      name: "memory-scoped-runtime-test",
      modelClient,
      model: "test-model",
      tools: [memoryPatchTool],
      systemPrompt: "You are helpful.",
      maxSteps: 4,
      memory,
    });

    const ctx = baseCtx({ inputText: "continue the implementation" });
    ctx.identity = {
      userId: "user-a",
      tenantId: "tenant-a",
      roles: [],
    };
    ctx.metadata = {
      projectMemoryKey: "tenant-a/repo-a",
    };

    const result = await runtime.run(ctx);

    expect(result.status).toBe("completed");
    expect(observedPrompt).toContain("Finish the SDK memory foundation.");
    expect(observedPrompt).toContain("Keep responses terse.");
    expect(observedPrompt).toContain("Always write red tests first.");
    const persistedProjectSnapshot = createMemorySnapshot(
      scopedSnapshots.get("project:tenant-a/repo-a") ?? undefined,
    );
    expect(
      persistedProjectSnapshot.semantic.entries.some((entry) => entry.id === "project:new"),
    ).toBe(true);
  });
});

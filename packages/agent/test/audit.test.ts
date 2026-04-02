import { describe, expect, it, vi } from "vitest";

import type { ModelClient, ModelResponse } from "@renx/model";

import { ConsoleAuditLogger } from "../src/audit";
import { AgentRuntime } from "../src/runtime";
import { baseCtx } from "./helpers";

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

describe("ConsoleAuditLogger", () => {
  it("log() outputs to console with correct format", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const logger = new ConsoleAuditLogger();
    logger.log({
      id: "evt_1",
      runId: "run_abc",
      type: "run_started",
      timestamp: "2026-01-01T00:00:00Z",
      payload: { stepCount: 0 },
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("[Audit:run_started] run=run_abc", { stepCount: 0 });

    logSpy.mockRestore();
  });
});

describe("runtime audit integration", () => {
  it("emits audit events with correct runId", async () => {
    const events: { type: string; runId: string }[] = [];
    const auditLogger = {
      log: (event: { type: string; runId: string }) => {
        events.push({ type: event.type, runId: event.runId });
      },
    };

    const modelClient = createMockModelClient([{ type: "final", output: "Hello!" }]);

    const runtime = new AgentRuntime({
      name: "audit-test",
      modelClient,
      model: "test-model",
      tools: [],
      systemPrompt: "You are helpful.",
      maxSteps: 5,
      audit: auditLogger,
    });

    const ctx = baseCtx({ inputText: "Hi" });
    const result = await runtime.run(ctx);

    // Verify events were emitted
    expect(events.length).toBeGreaterThan(0);

    // All events should have the same runId as the result
    for (const event of events) {
      expect(event.runId).toBe(result.runId);
      expect(event.runId).not.toBe("");
    }
  });

  it("emits expected audit event types for a completed run", async () => {
    const eventTypes: string[] = [];
    const auditLogger = {
      log: (event: { type: string }) => {
        eventTypes.push(event.type);
      },
    };

    const modelClient = createMockModelClient([{ type: "final", output: "Done!" }]);

    const runtime = new AgentRuntime({
      name: "audit-types-test",
      modelClient,
      model: "test-model",
      tools: [],
      systemPrompt: "You are helpful.",
      maxSteps: 5,
      audit: auditLogger,
    });

    const ctx = baseCtx({ inputText: "Hi" });
    await runtime.run(ctx);

    expect(eventTypes).toContain("run_started");
    expect(eventTypes).toContain("context_budget_measured");
    expect(eventTypes).toContain("context_layer_applied");
    expect(eventTypes).toContain("model_called");
    expect(eventTypes).toContain("model_returned");
    expect(eventTypes).toContain("run_completed");
  });
});

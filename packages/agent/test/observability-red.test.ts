import { describe, expect, it } from "vitest";

import {
  InMemoryObservabilitySink,
  ObservabilityService,
  createMemorySnapshot,
  initialContextRuntimeState,
} from "../src";
import { baseCtx } from "./helpers";

describe("observability", () => {
  it("aggregates audit events with context and memory diagnostics into a health report", async () => {
    const sink = new InMemoryObservabilitySink();
    const service = new ObservabilityService(sink);
    const ctx = baseCtx({ inputText: "continue" });
    ctx.state.context = {
      ...initialContextRuntimeState(),
      lastBudget: {
        estimatedInputTokens: 1200,
        warningThreshold: 800,
        autoCompactThreshold: 1000,
        errorThreshold: 1200,
        blockingThreshold: 1300,
        inWarning: true,
        requiresAutoCompact: true,
        shouldBlock: false,
      },
    };
    ctx.state.memory = createMemorySnapshot({
      semantic: {
        entries: [
          {
            id: "project:secret",
            type: "project",
            content: "ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD",
            updatedAt: "2026-04-05T00:00:00.000Z",
            scope: "project",
          },
        ],
      },
    });

    await service.record({
      id: "evt_1",
      runId: ctx.state.runId,
      type: "context_auto_compact_triggered",
      timestamp: "2026-04-05T00:00:00.000Z",
      payload: { currentTokens: 1200 },
    });
    await service.record({
      id: "evt_2",
      runId: ctx.state.runId,
      type: "tool_failed",
      timestamp: "2026-04-05T00:00:01.000Z",
      payload: { toolName: "bash", code: "TOOL_ERROR" },
    });

    const report = await service.inspectRun(ctx, {
      promptTokenBudget: 100,
      staleSyncAfterHours: 1,
      now: "2026-04-05T12:00:00.000Z",
    });

    expect(report.counts["context_auto_compact_triggered"]).toBe(1);
    expect(report.counts["tool_failed"]).toBe(1);
    expect(report.memory.ok).toBe(false);
    expect(report.context.requiresAutoCompact).toBe(true);
  });
});

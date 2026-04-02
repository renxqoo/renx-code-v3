import { describe, expect, it } from "vitest";

import { ContextOrchestrator, initialContextRuntimeState } from "../../src/context";
import type { RunMessage } from "../../src/message/types";

const makeMessage = (idx: number): RunMessage => ({
  id: `m_${idx}`,
  messageId: `msg_${idx}`,
  role: idx % 2 === 0 ? "user" : "assistant",
  content: `content-${idx}-${"x".repeat(120)}`,
  createdAt: new Date(1_700_000_000_000 + idx).toISOString(),
  source: "input",
  roundIndex: Math.floor(idx / 2),
});

describe("ContextOrchestrator", () => {
  it("tracks compact boundary records on reactive recovery", () => {
    const orchestrator = new ContextOrchestrator();
    const canonical = Array.from({ length: 24 }, (_, idx) => makeMessage(idx));
    const state = {
      ...initialContextRuntimeState(),
      consecutiveCompactFailures: 2,
    };

    const recovered = orchestrator.onReactiveRecovery({
      contextState: state,
      canonicalMessages: canonical,
      reason: "context_overflow",
      memory: {},
    });

    expect(recovered.recovered).toBe(true);
    expect(recovered.nextState.compactBoundaries.length).toBe(1);
    expect(recovered.nextState.consecutiveCompactFailures).toBe(0);
  });

  it("stores compact boundary parent chain", () => {
    const orchestrator = new ContextOrchestrator();
    const canonical = Array.from({ length: 30 }, (_, idx) => makeMessage(idx));
    const state = initialContextRuntimeState();

    const first = orchestrator.onReactiveRecovery({
      contextState: state,
      canonicalMessages: canonical,
      reason: "context_overflow",
      memory: {},
    });
    const second = orchestrator.onReactiveRecovery({
      contextState: first.nextState,
      canonicalMessages: canonical,
      reason: "context_overflow",
      memory: {},
    });

    expect(second.recovered).toBe(true);
    expect(second.nextState.compactBoundaries.length).toBeGreaterThanOrEqual(2);
    const latest =
      second.nextState.compactBoundaries[second.nextState.compactBoundaries.length - 1];
    expect(latest?.parentBoundaryId).toBeDefined();
  });

  it("sets projected api view id in prepare result state", () => {
    const orchestrator = new ContextOrchestrator();
    const canonical = Array.from({ length: 4 }, (_, idx) => makeMessage(idx));
    const apiView = canonical.map(({ messageId: _messageId, source: _source, ...msg }) => msg);

    const prepared = orchestrator.prepare({
      systemPrompt: "system",
      tools: [],
      apiView,
      canonicalMessages: canonical,
      memory: {},
      contextState: initialContextRuntimeState(),
    });

    expect(prepared.nextState.lastProjectedApiViewId).toBeDefined();
  });

  it("updates session memory hot/cold tiers on model response", () => {
    const orchestrator = new ContextOrchestrator();
    const base = initialContextRuntimeState();
    base.roundIndex = 5;
    const next = orchestrator.onModelResponse({
      contextState: base,
      response: {
        type: "final",
        output:
          "This is a sufficiently long model output used to produce a session summary for context continuity and checkpoint memory updates.",
      },
      estimatedInputTokens: 500,
    });

    expect(next.sessionMemoryState?.hotSummaryText).toBeDefined();
    expect(next.sessionMemoryState?.coldSummaryText).toBeDefined();
    expect(next.sessionMemoryState?.lastColdSummaryAt).toBeDefined();
  });

  it("writes boundary when session memory compact is applied", () => {
    const orchestrator = new ContextOrchestrator({
      maxInputTokens: 100,
      thresholds: {
        warningBufferTokens: 0,
        autoCompactBufferTokens: 0,
        errorBufferTokens: 0,
        blockingHeadroomTokens: -10_000,
      },
    });
    const canonical = Array.from({ length: 20 }, (_, idx) => makeMessage(idx));
    const apiView = canonical.map(({ messageId: _messageId, source: _source, ...msg }) => msg);
    const prepared = orchestrator.prepare({
      systemPrompt: "system",
      tools: [],
      apiView,
      canonicalMessages: canonical,
      memory: {
        sessionSummary:
          "This is a session summary with enough content to trigger session memory compact behavior.",
      },
      contextState: initialContextRuntimeState(),
    });

    expect(prepared.nextState.compactBoundaries.some((b) => b.strategy === "session_memory")).toBe(
      true,
    );
  });
});

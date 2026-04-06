import { describe, expect, it } from "vitest";

import { ContextOrchestrator, initialContextRuntimeState } from "../../src/context";
import { createMemorySnapshot } from "../../src/memory";
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

  it("does not synthesize session-memory notes from arbitrary model output", () => {
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

    expect(next.sessionMemoryState).toEqual(base.sessionMemoryState);
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
      memory: {},
      contextState: {
        ...initialContextRuntimeState(),
        sessionMemoryState: {
          notes:
            "# Session Title\n_Test_\n\n# Current State\n_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._\nThis is a session summary with enough content to trigger session memory compact behavior.",
          initialized: true,
          tokensAtLastExtraction: 120,
        },
      },
    });

    expect(prepared.nextState.compactBoundaries.some((b) => b.strategy === "session_memory")).toBe(
      true,
    );
  });

  it("does not run heavy compaction layers when tool result budget alone restores headroom", () => {
    const orchestrator = new ContextOrchestrator({
      maxInputTokens: 12_000,
      thresholds: {
        warningBufferTokens: 2_000,
        autoCompactBufferTokens: 2_000,
        errorBufferTokens: 2_000,
        blockingHeadroomTokens: 1_000,
      },
    });
    const history = Array.from({ length: 110 }, (_, idx) => makeMessage(idx));
    const hugeToolResult: RunMessage = {
      id: "tool_huge",
      messageId: "tool_huge",
      role: "tool",
      content: "t".repeat(40_000),
      createdAt: new Date().toISOString(),
      source: "tool",
      roundIndex: 55,
      toolCallId: "call_1",
    };
    const canonical = [...history, hugeToolResult];
    const apiView = canonical.map(({ messageId: _messageId, source: _source, ...msg }) => msg);

    const prepared = orchestrator.prepare({
      systemPrompt: "system",
      tools: [],
      apiView,
      canonicalMessages: canonical,
      memory: {},
      contextState: initialContextRuntimeState(),
    });

    expect(prepared.canonicalMessages).toHaveLength(canonical.length);
    expect(prepared.nextState.lastLayerExecutions.some((l) => l.layer === "history_snip")).toBe(
      false,
    );
    expect(
      prepared.nextState.lastLayerExecutions.some(
        (l) => l.layer === "context_collapse" && l.reason === "Fold middle history band",
      ),
    ).toBe(false);
  });

  it("tracks the latest compact boundary as active boundary id", () => {
    const orchestrator = new ContextOrchestrator();
    const createdAt = new Date().toISOString();
    const canonical: RunMessage[] = [
      {
        ...makeMessage(0),
        id: "boundary_old",
        messageId: "boundary_old",
        role: "system",
        source: "framework",
        compactBoundary: {
          boundaryId: "boundary_old",
          strategy: "auto_compact",
          createdAt,
        },
      },
      {
        ...makeMessage(1),
        id: "summary_old",
        messageId: "summary_old",
        role: "system",
        source: "framework",
      },
      {
        ...makeMessage(2),
        id: "boundary_new",
        messageId: "boundary_new",
        role: "system",
        source: "framework",
        compactBoundary: {
          boundaryId: "boundary_new",
          strategy: "reactive_compact",
          createdAt,
        },
      },
      makeMessage(3),
      makeMessage(4),
    ];
    const apiView = canonical.map(({ messageId: _messageId, source: _source, ...msg }) => msg);

    const prepared = orchestrator.prepare({
      systemPrompt: "system",
      tools: [],
      apiView,
      canonicalMessages: canonical,
      memory: {},
      contextState: initialContextRuntimeState(),
    });

    expect(prepared.nextState.activeBoundaryId).toBe("boundary_new");
  });

  it("stores compact summary body instead of boundary text during reactive recovery", () => {
    const orchestrator = new ContextOrchestrator();
    const canonical = Array.from({ length: 24 }, (_, idx) => makeMessage(idx));

    const recovered = orchestrator.onReactiveRecovery({
      contextState: initialContextRuntimeState(),
      canonicalMessages: canonical,
      reason: "context_overflow",
      memory: {},
    });

    expect(recovered.recovered).toBe(true);
    const summaryMessage = recovered.canonicalMessages.find((m) => m.id.startsWith("summary_"));
    expect(summaryMessage).toBeDefined();
    const segmentId = summaryMessage?.preservedSegmentRef?.segmentId;
    expect(segmentId).toBeDefined();
    expect(recovered.nextState.preservedSegments[segmentId!]?.summary).toBe(
      summaryMessage?.content,
    );
  });

  it("preserves transient api-only memory context through auto compact", () => {
    const orchestrator = new ContextOrchestrator({
      maxInputTokens: 1_000,
      thresholds: {
        warningBufferTokens: 0,
        autoCompactBufferTokens: 800,
        errorBufferTokens: 800,
        blockingHeadroomTokens: -10_000,
      },
    });
    const canonical = Array.from({ length: 24 }, (_, idx) => makeMessage(idx));
    const apiView = [
      {
        id: "memory_only",
        role: "system" as const,
        content: '[Agent Memory]\n{"activePlan":"keep me visible after compaction"}',
        createdAt: new Date().toISOString(),
      },
      ...canonical.map(({ messageId: _messageId, source: _source, ...msg }) => msg),
    ];

    const prepared = orchestrator.prepare({
      systemPrompt: "system",
      tools: [],
      apiView,
      canonicalMessages: canonical,
      memory: {},
      contextState: {
        ...initialContextRuntimeState(),
        sessionMemoryState: {
          notes:
            "# Session Title\n_Test_\n\n# Current State\n_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._\nThis is a session summary with enough content to trigger session memory compact behavior.",
          initialized: true,
          tokensAtLastExtraction: 120,
        },
      },
    });

    expect(
      prepared.nextState.lastLayerExecutions.some(
        (layer) => layer.layer === "session_memory_compact" || layer.layer === "auto_compact",
      ),
    ).toBe(true);
    expect(prepared.messages.map((m) => m.id)).toContain("memory_only");
  });

  it("does not overwrite raw tool result cache with hydrated partial content on re-prepare", () => {
    const orchestrator = new ContextOrchestrator({
      toolResultSoftCharLimit: 1_000,
    });
    const rawToolContent = "x".repeat(10_000);
    const state = initialContextRuntimeState();
    state.toolResultCache.tool_1 = rawToolContent;
    const canonical: RunMessage[] = [
      {
        id: "tool_1",
        messageId: "tool_1",
        role: "tool",
        content: "[tool_result_cache_ref:tool_1] tool result compacted due to budget",
        createdAt: new Date().toISOString(),
        source: "tool",
        roundIndex: 0,
        toolCallId: "call_1",
      },
    ];
    const apiView = canonical.map(({ messageId: _messageId, source: _source, ...msg }) => msg);

    const prepared = orchestrator.prepare({
      systemPrompt: "system",
      tools: [],
      apiView,
      canonicalMessages: canonical,
      memory: {},
      contextState: state,
    });

    expect(prepared.nextState.toolResultCache.tool_1).toBe(rawToolContent);
  });

  it("does not accumulate duplicate rehydration hints across repeated reactive recovery", () => {
    const orchestrator = new ContextOrchestrator();
    const memory = createMemorySnapshot({
      working: {
        activePlan: {
          step: "keep-context",
        },
      },
    });
    const canonical = Array.from({ length: 24 }, (_, idx) => makeMessage(idx));

    const first = orchestrator.onReactiveRecovery({
      contextState: initialContextRuntimeState(),
      canonicalMessages: canonical,
      reason: "context_overflow",
      memory,
    });
    expect(first.recovered).toBe(true);

    const second = orchestrator.onReactiveRecovery({
      contextState: first.nextState,
      canonicalMessages: first.canonicalMessages,
      reason: "context_overflow",
      memory,
    });
    expect(second.recovered).toBe(true);

    const rehydrationMessages = second.canonicalMessages.filter((m) =>
      m.id.startsWith("rehydration_"),
    );
    expect(rehydrationMessages).toHaveLength(1);
  });

  it("adds rehydration hints even when reactive recovery falls back to round trimming", () => {
    const orchestrator = new ContextOrchestrator();
    const canonical = Array.from(
      { length: 5 },
      (_, idx) =>
        ({
          id: `m_${idx}`,
          messageId: `msg_${idx}`,
          role: idx % 2 === 0 ? "user" : "assistant",
          content: `payload-${idx}-${"x".repeat(180)}`,
          createdAt: new Date(1_700_000_000_000 + idx).toISOString(),
          source: "input" as const,
          roundIndex: idx,
        }) satisfies RunMessage,
    );

    const recovered = orchestrator.onReactiveRecovery({
      contextState: initialContextRuntimeState(),
      canonicalMessages: canonical,
      reason: "prompt_too_long",
      memory: createMemorySnapshot({
        working: {
          activePlan: "keep me",
        },
      }),
    });

    expect(recovered.recovered).toBe(true);
    expect(recovered.canonicalMessages.some((m) => m.id.startsWith("rehydration_"))).toBe(true);
  });

  it("resets compact failure counter after successful fallback reactive recovery", () => {
    const orchestrator = new ContextOrchestrator();
    const canonical = Array.from(
      { length: 5 },
      (_, idx) =>
        ({
          id: `m_${idx}`,
          messageId: `msg_${idx}`,
          role: idx % 2 === 0 ? "user" : "assistant",
          content: `payload-${idx}-${"x".repeat(180)}`,
          createdAt: new Date(1_700_000_000_000 + idx).toISOString(),
          source: "input" as const,
          roundIndex: idx,
        }) satisfies RunMessage,
    );

    const recovered = orchestrator.onReactiveRecovery({
      contextState: {
        ...initialContextRuntimeState(),
        consecutiveCompactFailures: 2,
      },
      canonicalMessages: canonical,
      reason: "prompt_too_long",
      memory: {},
    });

    expect(recovered.recovered).toBe(true);
    expect(recovered.nextState.consecutiveCompactFailures).toBe(0);
  });
});

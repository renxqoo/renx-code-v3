import { describe, expect, it } from "vitest";

import type { AgentMessage } from "@renx/model";

import { ContextOrchestrator, initialContextRuntimeState } from "../../src/context";
import { projectApiView } from "../../src/context/api-view";
import { applyContextCollapse, restoreCollapsedContext } from "../../src/context/context-collapse";
import type { RunMessage } from "../../src/message/types";

const makeCanonical = (idx: number): RunMessage => ({
  id: `m_${idx}`,
  messageId: `msg_${idx}`,
  role: idx % 2 === 0 ? "user" : "assistant",
  content: `content-${idx}-${"x".repeat(80)}`,
  createdAt: new Date(1_700_000_000_000 + idx).toISOString(),
  source: "input",
  roundIndex: Math.floor(idx / 2),
});

describe("context acceptance matrix", () => {
  it("ACPT-CWM-01 blocks when compact breaker opens", () => {
    const orchestrator = new ContextOrchestrator({ maxConsecutiveCompactFailures: 1 });
    const state = initialContextRuntimeState();
    state.consecutiveCompactFailures = 1;
    const canonical = [makeCanonical(0), makeCanonical(1)];
    const api = canonical.map(({ messageId: _messageId, source: _source, ...m }) => m);

    const prepared = orchestrator.prepare({
      systemPrompt: "sys",
      tools: [],
      apiView: api,
      canonicalMessages: canonical,
      memory: {},
      contextState: state,
    });

    expect(prepared.budget.shouldBlock).toBe(true);
  });

  it("ACPT-CWM-02 restores collapsed context by dynamic headroom", () => {
    const state = initialContextRuntimeState();
    const base: AgentMessage[] = Array.from({ length: 18 }, (_, i) => ({
      id: `a_${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `segment-${i}-${"x".repeat(80)}`,
      createdAt: new Date(1_700_000_000_000 + i).toISOString(),
    }));
    const collapsed = applyContextCollapse(base, state);
    const restoredLow = restoreCollapsedContext(collapsed.messages, collapsed.nextState, 8, 10);
    const restoredHigh = restoreCollapsedContext(collapsed.messages, collapsed.nextState, 8, 400);

    expect(restoredLow.restored).toBe(false);
    expect(restoredHigh.restored).toBe(true);
    expect(restoredHigh.messages.length).toBeGreaterThan(collapsed.messages.length);
  });

  it("ACPT-CWM-03 reactive recovery creates compact boundaries", () => {
    const orchestrator = new ContextOrchestrator();
    const canonical = Array.from({ length: 26 }, (_, idx) => makeCanonical(idx));
    const recovered = orchestrator.onReactiveRecovery({
      contextState: initialContextRuntimeState(),
      canonicalMessages: canonical,
      reason: "context_overflow",
      memory: {},
    });

    expect(recovered.recovered).toBe(true);
    expect(recovered.nextState.compactBoundaries.length).toBeGreaterThan(0);
  });

  it("ACPT-CWM-04 api view can recover summary from preserved segment", () => {
    const state = initialContextRuntimeState();
    state.preservedSegments["s1"] = {
      digest: "d1",
      summary: "summary from segment store",
      messageIds: ["x1", "x2"],
      createdAt: new Date().toISOString(),
    };
    const boundary: RunMessage = {
      ...makeCanonical(0),
      id: "boundary",
      compactBoundary: {
        boundaryId: "b1",
        strategy: "auto_compact",
        createdAt: new Date().toISOString(),
      },
      preservedSegmentRef: {
        segmentId: "s1",
        digest: "d1",
      },
    };
    const tail: RunMessage = makeCanonical(1);
    const canonical = [makeCanonical(99), boundary, tail];
    const api = canonical.map(({ messageId: _messageId, source: _source, ...m }) => m);

    const projected = projectApiView(api, canonical, state);
    expect(projected.canonical.some((m) => m.id.startsWith("restored_summary_"))).toBe(true);
  });
});

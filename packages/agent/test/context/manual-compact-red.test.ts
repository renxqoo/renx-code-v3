import { describe, expect, it } from "vitest";

import type { AgentMessage, ToolDefinition } from "@renx/model";

import { ContextOrchestrator, initialContextRuntimeState } from "../../src/context";
import type { RunMessage } from "../../src/message/types";

const noTools: ToolDefinition[] = [];

const makeMessage = (idx: number): RunMessage => ({
  id: `m_${idx}`,
  messageId: `msg_${idx}`,
  role: idx % 2 === 0 ? "user" : "assistant",
  content: `content-${idx}-${"x".repeat(120)}`,
  createdAt: new Date(1_700_000_000_000 + idx).toISOString(),
  source: "input",
  roundIndex: Math.floor(idx / 2),
});

const toApi = (messages: RunMessage[]): AgentMessage[] =>
  messages.map(({ messageId: _messageId, source: _source, roundIndex: _roundIndex, ...m }) => m);

describe("manual compact red tests", () => {
  it("supports forced manual compact even when thresholds are still healthy", () => {
    const orchestrator = new ContextOrchestrator({
      maxInputTokens: 50_000,
    });
    const canonical = Array.from({ length: 16 }, (_, idx) => makeMessage(idx));

    const prepared = orchestrator.compact({
      systemPrompt: "system",
      tools: noTools,
      apiView: toApi(canonical),
      canonicalMessages: canonical,
      memory: {},
      contextState: initialContextRuntimeState(),
    });

    expect(prepared.canonicalMessages?.[0]?.compactBoundary?.strategy).toBe("manual_compact");
    expect(prepared.nextState.compactBoundaries.some((b) => b.strategy === "manual_compact")).toBe(
      true,
    );
  });

  it("manual compact preserves custom instructions inside compact summary seed", () => {
    const orchestrator = new ContextOrchestrator();
    const canonical = Array.from({ length: 16 }, (_, idx) => makeMessage(idx));

    const prepared = orchestrator.compact({
      systemPrompt: "system",
      tools: noTools,
      apiView: toApi(canonical),
      canonicalMessages: canonical,
      memory: {},
      contextState: initialContextRuntimeState(),
      customInstructions: "Focus on TypeScript code changes and preserve open TODOs.",
    });

    const summaryMessage = (prepared.canonicalMessages ?? []).find((message) =>
      message.id.startsWith("summary_"),
    );
    expect(summaryMessage?.content).toContain("Focus on TypeScript code changes");
  });

  it("manual compact prefers session memory fast path when no custom instructions are given", () => {
    const orchestrator = new ContextOrchestrator();
    const canonical = Array.from({ length: 16 }, (_, idx) => makeMessage(idx));
    const state = initialContextRuntimeState();
    state.sessionMemoryState = {
      notes:
        "# Session Title\n_Test_\n\n# Current State\n_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._\nsession memory hot summary with enough detail to compact safely",
      initialized: true,
      tokensAtLastExtraction: 120,
    };

    const prepared = orchestrator.compact({
      systemPrompt: "system",
      tools: noTools,
      apiView: toApi(canonical),
      canonicalMessages: canonical,
      memory: {},
      contextState: state,
    });

    expect(prepared.canonicalMessages?.[0]?.compactBoundary?.strategy).toBe("session_memory");
  });
});

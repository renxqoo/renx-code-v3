import { describe, expect, it } from "vitest";

import type { AgentMessage, ToolDefinition } from "@renx/model";

import { ContextOrchestrator, initialContextRuntimeState } from "../../src/context";
import { applyAutoCompact } from "../../src/context/auto-compact";
import { applySessionMemoryCompact } from "../../src/context/session-memory-compact";
import { createMemorySnapshot } from "../../src/memory";
import type { RunMessage } from "../../src/message/types";

const noTools: ToolDefinition[] = [];

const toApi = (messages: RunMessage[]): AgentMessage[] =>
  messages.map(({ messageId: _messageId, source: _source, roundIndex: _roundIndex, ...m }) => m);

const makeMessage = (
  id: string,
  role: RunMessage["role"],
  roundIndex: number,
  extra?: Partial<RunMessage>,
): RunMessage => ({
  id,
  messageId: `${id}_msg`,
  role,
  content: `${id}-content-${"x".repeat(80)}`,
  createdAt: new Date(1_700_000_000_000 + roundIndex).toISOString(),
  source: "input",
  roundIndex,
  ...extra,
});

describe("behavior parity red tests", () => {
  it("auto compact keeps assistant tool call when the matching tool result is in the preserved tail", () => {
    const canonical: RunMessage[] = [
      makeMessage("m0", "user", 0),
      makeMessage("m1", "assistant", 0),
      makeMessage("m2", "user", 1),
      makeMessage("assistant_call", "assistant", 1, {
        toolCalls: [{ id: "tc_1", name: "echo", input: { text: "hi" } }],
      }),
      makeMessage("tool_result", "tool", 2, {
        toolCallId: "tc_1",
        name: "echo",
      }),
      makeMessage("m5", "assistant", 2),
      makeMessage("m6", "user", 3),
      makeMessage("m7", "assistant", 3),
      makeMessage("m8", "user", 4),
      makeMessage("m9", "assistant", 4),
      makeMessage("m10", "user", 5),
      makeMessage("m11", "assistant", 5),
    ];

    const compacted = applyAutoCompact(toApi(canonical), canonical, "auto_compact");
    const keptIds = compacted.canonicalMessages.map((m) => m.id);

    expect(keptIds).toContain("assistant_call");
    expect(keptIds).toContain("tool_result");
  });

  it("auto compact keeps the full thinking chunk group when the split lands in the middle", () => {
    const canonical: RunMessage[] = [
      makeMessage("m0", "user", 0),
      makeMessage("m1", "assistant", 0),
      makeMessage("m2", "user", 1),
      makeMessage("thinking_head", "assistant", 1, {
        thinkingChunkGroupId: "th_1",
      }),
      makeMessage("thinking_tail", "assistant", 2, {
        thinkingChunkGroupId: "th_1",
      }),
      makeMessage("m5", "assistant", 2),
      makeMessage("m6", "user", 3),
      makeMessage("m7", "assistant", 3),
      makeMessage("m8", "user", 4),
      makeMessage("m9", "assistant", 4),
      makeMessage("m10", "user", 5),
      makeMessage("m11", "assistant", 5),
    ];

    const compacted = applyAutoCompact(toApi(canonical), canonical, "auto_compact");
    const keptIds = compacted.canonicalMessages.map((m) => m.id);

    expect(keptIds).toContain("thinking_head");
    expect(keptIds).toContain("thinking_tail");
  });

  it("session memory compact keeps assistant tool call when the matching tool result is in the preserved tail", () => {
    const state = initialContextRuntimeState();
    state.sessionMemoryState = {
      notes:
        "# Session Title\n_Test_\n\n# Current State\n_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._\nhot summary with enough content for session memory compaction to activate",
      initialized: true,
      tokensAtLastExtraction: 120,
    };

    const canonical: RunMessage[] = [
      makeMessage("m0", "user", 0),
      makeMessage("m1", "assistant", 0),
      makeMessage("m2", "user", 1),
      makeMessage("assistant_call", "assistant", 1, {
        toolCalls: [{ id: "tc_1", name: "echo", input: { text: "hi" } }],
      }),
      makeMessage("tool_result", "tool", 2, {
        toolCallId: "tc_1",
        name: "echo",
      }),
      makeMessage("m5", "assistant", 2),
      makeMessage("m6", "user", 3),
      makeMessage("m7", "assistant", 3),
      makeMessage("m8", "user", 4),
      makeMessage("m9", "assistant", 4),
      makeMessage("m10", "user", 5),
      makeMessage("m11", "assistant", 5),
    ];

    const compacted = applySessionMemoryCompact(toApi(canonical), canonical, {}, state);
    const keptIds = compacted.canonicalMessages.map((m) => m.id);

    expect(keptIds).toContain("assistant_call");
    expect(keptIds).toContain("tool_result");
  });

  it("session memory compact keeps the full thinking chunk group when the split lands in the middle", () => {
    const state = initialContextRuntimeState();
    state.sessionMemoryState = {
      notes:
        "# Session Title\n_Test_\n\n# Current State\n_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._\nhot summary with enough content for session memory compaction to activate",
      initialized: true,
      tokensAtLastExtraction: 120,
    };

    const canonical: RunMessage[] = [
      makeMessage("m0", "user", 0),
      makeMessage("m1", "assistant", 0),
      makeMessage("m2", "user", 1),
      makeMessage("thinking_head", "assistant", 1, {
        thinkingChunkGroupId: "th_1",
      }),
      makeMessage("thinking_tail", "assistant", 2, {
        thinkingChunkGroupId: "th_1",
      }),
      makeMessage("m5", "assistant", 2),
      makeMessage("m6", "user", 3),
      makeMessage("m7", "assistant", 3),
      makeMessage("m8", "user", 4),
      makeMessage("m9", "assistant", 4),
      makeMessage("m10", "user", 5),
      makeMessage("m11", "assistant", 5),
    ];

    const compacted = applySessionMemoryCompact(toApi(canonical), canonical, {}, state);
    const keptIds = compacted.canonicalMessages.map((m) => m.id);

    expect(keptIds).toContain("thinking_head");
    expect(keptIds).toContain("thinking_tail");
  });

  it("prepare appends rehydration hints after auto compact so recent context is reintroduced immediately", () => {
    const orchestrator = new ContextOrchestrator({
      maxInputTokens: 800,
      thresholds: {
        warningBufferTokens: 0,
        autoCompactBufferTokens: 700,
        errorBufferTokens: 100,
        blockingHeadroomTokens: 0,
      },
    });

    const canonical = Array.from({ length: 12 }, (_, idx) =>
      makeMessage(`m${idx}`, idx % 2 === 0 ? "user" : "assistant", idx),
    );

    const prepared = orchestrator.prepare({
      systemPrompt: "system",
      tools: noTools,
      apiView: toApi(canonical),
      canonicalMessages: canonical,
      memory: createMemorySnapshot({
        working: {
          recentFiles: [
            {
              path: "src/context/index.ts",
              content: "prepare() should append rehydration hints after compaction.",
              updatedAt: "2026-04-05T00:00:00.000Z",
            },
            {
              path: "src/context/auto-compact.ts",
              content: "applyAutoCompact() preserves a protocol-safe tail.",
              updatedAt: "2026-04-05T00:01:00.000Z",
            },
          ],
          activePlan: "keep parity with Claude compaction behavior",
          skills: [
            {
              name: "context-parity",
              content: "Preserve Claude-style compaction continuity.",
              updatedAt: "2026-04-05T00:02:00.000Z",
            },
            {
              name: "session-memory",
              content: "Rehydrate working context immediately after compact.",
              updatedAt: "2026-04-05T00:03:00.000Z",
            },
          ],
        },
      }),
      contextState: initialContextRuntimeState(),
    });

    expect(prepared.messages.some((message) => message.id.startsWith("rehydration_"))).toBe(true);
  });

  it("prepare appends rehydration hints after session memory compact", () => {
    const orchestrator = new ContextOrchestrator({
      maxInputTokens: 800,
      thresholds: {
        warningBufferTokens: 0,
        autoCompactBufferTokens: 700,
        errorBufferTokens: 100,
        blockingHeadroomTokens: 0,
      },
    });

    const canonical = Array.from({ length: 12 }, (_, idx) =>
      makeMessage(`m${idx}`, idx % 2 === 0 ? "user" : "assistant", idx),
    );
    const contextState = initialContextRuntimeState();
    contextState.sessionMemoryState = {
      notes:
        "# Session Title\n_Test_\n\n# Current State\n_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._\nhot summary with enough content for session memory compaction to activate",
      initialized: true,
      tokensAtLastExtraction: 120,
    };

    const prepared = orchestrator.prepare({
      systemPrompt: "system",
      tools: noTools,
      apiView: toApi(canonical),
      canonicalMessages: canonical,
      memory: createMemorySnapshot({
        working: {
          recentFiles: [
            {
              path: "src/context/session-memory-compact.ts",
              content: "Fast-path compact should preserve the newest working set.",
              updatedAt: "2026-04-05T00:04:00.000Z",
            },
          ],
          activePlan: "keep recent session memory context available immediately after compaction",
        },
      }),
      contextState,
    });

    expect(prepared.messages.some((message) => message.id.startsWith("rehydration_"))).toBe(true);
  });

  it("session memory compact preserves all messages newer than summarySourceRound when enough fresh context exists", () => {
    const state = initialContextRuntimeState();
    state.sessionMemoryState = {
      notes:
        "# Session Title\n_Test_\n\n# Current State\n_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._\nhot summary with enough content for session memory compaction to activate",
      initialized: true,
      tokensAtLastExtraction: 120,
      summarySourceRound: 3,
    };

    const canonical = Array.from({ length: 20 }, (_, idx) =>
      makeMessage(`m${idx}`, idx % 2 === 0 ? "user" : "assistant", Math.floor(idx / 2)),
    );

    const compacted = applySessionMemoryCompact(toApi(canonical), canonical, {}, state);
    const keptIds = compacted.canonicalMessages.slice(2).map((m) => m.id);

    expect(keptIds).toContain("m8");
    expect(keptIds).toContain("m9");
    expect(keptIds).toContain("m18");
    expect(keptIds).toContain("m19");
  });
});

import { describe, expect, it } from "vitest";

import type { AgentMessage } from "@renx/model";

import { initialContextRuntimeState } from "../../src/context";
import { DEFAULT_SESSION_MEMORY_TEMPLATE } from "../../src/context/session-memory";
import { applySessionMemoryCompact } from "../../src/context/session-memory-compact";
import type { RunMessage } from "../../src/message/types";

const buildMessages = (): AgentMessage[] =>
  Array.from({ length: 12 }, (_, i) => ({
    id: `m_${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message-${i}`,
    createdAt: new Date(1_700_000_000_000 + i).toISOString(),
  }));

describe("session memory compact", () => {
  it("wraps session memory in the Claude-style continuation message", () => {
    const state = initialContextRuntimeState();
    state.sessionMemoryState = {
      notes:
        "# Session Title\n_Test_\n\n# Current State\n_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._\nhot summary with enough content for compact context reuse",
      initialized: true,
      tokensAtLastExtraction: 120,
    };

    const canonical: RunMessage[] = buildMessages().map((m, i) => ({
      ...m,
      messageId: `msg_${i}`,
      source: "input",
      roundIndex: Math.floor(i / 2),
    }));
    const compacted = applySessionMemoryCompact(buildMessages(), canonical, {}, state);
    const first = compacted.messages[0];
    expect(first?.role).toBe("system");
    expect(compacted.messages[1]?.content).toContain(
      "This session is being continued from a previous conversation that ran out of context.",
    );
    expect(compacted.messages[1]?.content).toContain("Recent messages are preserved verbatim.");
    expect(compacted.boundary?.strategy).toBe("session_memory");
    expect(compacted.nextState.sessionMemoryState?.notes).toContain("hot summary");
  });

  it("rebuilds api view from canonical tail when current api view was already collapsed", () => {
    const state = initialContextRuntimeState();
    state.sessionMemoryState = {
      notes:
        "# Session Title\n_Test_\n\n# Current State\n_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._\nhot summary with enough content for compact context reuse",
      initialized: true,
      tokensAtLastExtraction: 120,
    };

    const fullMessages = buildMessages();
    const canonical: RunMessage[] = fullMessages.map((m, i) => ({
      ...m,
      messageId: `msg_${i}`,
      source: "input",
      roundIndex: i,
    }));
    const collapsedApiView = [
      ...fullMessages.slice(0, 3),
      {
        id: "collapse_marker",
        role: "system" as const,
        content: "[Context Collapse] 3 messages folded.",
        createdAt: new Date().toISOString(),
        metadata: {
          segmentId: "collapse_segment_1",
        },
      },
      ...fullMessages.slice(-6),
    ];

    const compacted = applySessionMemoryCompact(collapsedApiView, canonical, {}, state);

    const expectedTailIds = compacted.canonicalMessages.slice(2).map((m) => m.id);
    const apiIds = new Set(compacted.messages.map((m) => m.id));
    for (const id of expectedTailIds) {
      expect(apiIds.has(id)).toBe(true);
    }
  });

  it("expands backward to keep a minimum fresh text window instead of only the last fixed tail", () => {
    const state = initialContextRuntimeState();
    state.sessionMemoryState = {
      notes:
        "# Session Title\n_Test_\n\n# Current State\n_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._\nhot summary with enough content for compact context reuse",
      initialized: true,
      tokensAtLastExtraction: 120,
      summarySourceRound: 20,
    };

    const canonical: RunMessage[] = Array.from({ length: 24 }, (_, i) => ({
      id: `m_${i}`,
      messageId: `msg_${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m${i}`,
      createdAt: new Date(1_700_000_000_000 + i).toISOString(),
      source: "input",
      roundIndex: i,
    }));
    const apiView = canonical.map(
      ({ messageId: _messageId, source: _source, roundIndex: _roundIndex, ...m }) => m,
    );

    const compacted = applySessionMemoryCompact(apiView, canonical, {}, state);
    const keptTailIds = compacted.canonicalMessages.slice(2).map((m) => m.id);

    expect(keptTailIds[0]).toBeDefined();
    expect(Number.parseInt(String(keptTailIds[0]).replace("m_", ""), 10)).toBeLessThan(16);
    expect(keptTailIds).toContain("m_23");
  });

  it("stores preserved segment relink metadata on session-memory compact boundaries", () => {
    const state = initialContextRuntimeState();
    state.sessionMemoryState = {
      notes:
        "# Session Title\n_Test_\n\n# Current State\n_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._\nhot summary with enough content for compact context reuse",
      initialized: true,
      tokensAtLastExtraction: 120,
    };

    const canonical: RunMessage[] = buildMessages().map((m, i) => ({
      ...m,
      messageId: `msg_${i}`,
      source: "input",
      roundIndex: Math.floor(i / 2),
    }));
    const compacted = applySessionMemoryCompact(buildMessages(), canonical, {}, state);
    const boundary = compacted.canonicalMessages[0];
    const summary = compacted.canonicalMessages[1];
    const tail = compacted.canonicalMessages[2];

    expect(boundary?.metadata?.["preservedSegmentRelink"]).toEqual({
      headMessageId: tail?.id,
      anchorMessageId: summary?.id,
      tailMessageId: compacted.canonicalMessages[compacted.canonicalMessages.length - 1]?.id,
    });
  });

  it("uses last summarized message id to preserve the full fresh chain beyond the fixed fallback tail", () => {
    const state = initialContextRuntimeState();
    state.sessionMemoryState = {
      notes:
        "# Session Title\n_Test_\n\n# Current State\n_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._\nhot summary with enough content for compact context reuse",
      initialized: true,
      tokensAtLastExtraction: 120,
      lastSummarizedMessageId: "m_10",
    } as never;

    const canonical: RunMessage[] = Array.from({ length: 24 }, (_, i) => ({
      id: `m_${i}`,
      messageId: `msg_${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message-${i}`,
      createdAt: new Date(1_700_000_000_000 + i).toISOString(),
      source: "input",
    }));
    const apiView = canonical.map(({ messageId: _messageId, source: _source, ...m }) => m);

    const compacted = applySessionMemoryCompact(apiView, canonical, {}, state);
    const keptTailIds = compacted.canonicalMessages.slice(2).map((m) => m.id);

    expect(keptTailIds[0]).toBe("m_11");
    expect(keptTailIds).toContain("m_23");
    expect(keptTailIds).not.toContain("m_10");
  });

  it("falls back when notes are still just the untouched template", () => {
    const state = initialContextRuntimeState();
    state.sessionMemoryState = {
      notes: DEFAULT_SESSION_MEMORY_TEMPLATE,
      initialized: true,
      tokensAtLastExtraction: 120,
    };

    const canonical: RunMessage[] = buildMessages().map((m, i) => ({
      ...m,
      messageId: `msg_${i}`,
      source: "input",
      roundIndex: Math.floor(i / 2),
    }));
    const compacted = applySessionMemoryCompact(buildMessages(), canonical, {}, state);

    expect(compacted.compactedMessageCount).toBe(0);
    expect(compacted.boundary).toBeUndefined();
    expect(compacted.canonicalMessages).toEqual(canonical);
  });
});

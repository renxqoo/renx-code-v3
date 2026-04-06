import { describe, expect, it } from "vitest";

import type { RunMessage } from "../../src/message/types";
import { applyAutoCompact, trimOldestRoundGroups } from "../../src/context/auto-compact";

const makeMessage = (idx: number, roundIndex: number): RunMessage => ({
  id: `m_${idx}`,
  messageId: `msg_${idx}`,
  role: idx % 3 === 0 ? "tool" : idx % 2 === 0 ? "user" : "assistant",
  content: `line-${idx}-${"x".repeat(80)}`,
  createdAt: new Date(1_700_000_000_000 + idx).toISOString(),
  source: "input",
  roundIndex,
});

describe("auto compact", () => {
  it("creates boundary + summary and preserved segment refs", () => {
    const canonical = Array.from({ length: 20 }, (_, idx) => makeMessage(idx, Math.floor(idx / 2)));
    const apiView = canonical.map(({ messageId: _messageId, source: _source, ...m }) => m);

    const compacted = applyAutoCompact(apiView, canonical, "auto_compact");
    expect(compacted.compactedMessageCount).toBeGreaterThan(0);
    expect(compacted.canonicalMessages[0]?.compactBoundary).toBeDefined();
    expect(compacted.canonicalMessages[1]?.content).toContain(
      "Compaction seed for model summarization",
    );
    expect(compacted.canonicalMessages[1]?.preservedSegmentRef).toBeDefined();
  });

  it("trimOldestRoundGroups drops oldest grouped rounds", () => {
    const canonical = Array.from({ length: 12 }, (_, idx) => makeMessage(idx, idx));
    const trimmed = trimOldestRoundGroups(canonical, 3);
    expect(trimmed.length).toBeLessThan(canonical.length);
    expect(trimmed[0]?.roundIndex).toBe(3);
  });

  it("drops oldest rounds when compact request is too long", () => {
    const canonical = Array.from({ length: 30 }, (_, idx) => makeMessage(idx, idx));
    const apiView = canonical.map(({ messageId: _messageId, source: _source, ...m }) => m);

    const compacted = applyAutoCompact(apiView, canonical, "auto_compact", {
      maxCompactRequestRetries: 2,
      compactRequestMaxInputChars: 800,
      historySnipMaxDropRounds: 2,
    });
    const remainingIds = compacted.canonicalMessages.map((m) => m.id);

    expect(remainingIds).not.toContain("m_0");
    expect(compacted.compactedMessageCount).toBeGreaterThan(0);
  });

  it("rebuilds api view from preserved canonical tail when current api view was already collapsed", () => {
    const canonical = Array.from({ length: 16 }, (_, idx) => makeMessage(idx, idx));
    const apiView = [
      ...canonical.slice(0, 3),
      {
        id: "collapse_marker",
        messageId: "collapse_marker",
        role: "system" as const,
        content: "[Context Collapse] 7 messages folded.",
        createdAt: new Date().toISOString(),
        source: "framework" as const,
        roundIndex: 999,
        metadata: {
          segmentId: "collapse_segment_1",
        },
      },
      ...canonical.slice(-6),
    ].map(({ messageId: _messageId, source: _source, roundIndex: _roundIndex, ...m }) => m);

    const compacted = applyAutoCompact(apiView, canonical, "auto_compact");

    const expectedTailIds = compacted.canonicalMessages.slice(2).map((m) => m.id);
    expect(expectedTailIds).toHaveLength(8);
    const apiIds = new Set(compacted.apiView.map((m) => m.id));
    for (const id of expectedTailIds) {
      expect(apiIds.has(id)).toBe(true);
    }
  });

  it("stores preserved segment relink metadata on the boundary for transcript reconstruction", () => {
    const canonical = Array.from({ length: 20 }, (_, idx) => makeMessage(idx, Math.floor(idx / 2)));
    const apiView = canonical.map(({ messageId: _messageId, source: _source, ...m }) => m);

    const compacted = applyAutoCompact(apiView, canonical, "auto_compact");
    const boundary = compacted.canonicalMessages[0];
    const summary = compacted.canonicalMessages[1];
    const tail = compacted.canonicalMessages[2];

    expect(boundary?.metadata?.["preservedSegmentRelink"]).toEqual({
      headMessageId: tail?.id,
      anchorMessageId: summary?.id,
      tailMessageId: compacted.canonicalMessages[compacted.canonicalMessages.length - 1]?.id,
    });
  });
});

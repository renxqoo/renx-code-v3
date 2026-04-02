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
});

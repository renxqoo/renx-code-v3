import { describe, expect, it } from "vitest";

import type { AgentMessage } from "@renx/model";

import { projectApiView } from "../../src/context/api-view";
import type { RunMessage } from "../../src/message/types";
import { initialContextRuntimeState } from "../../src/context";

const makeCanonical = (id: string, content: string, boundaryId?: string): RunMessage => ({
  id,
  messageId: `${id}_msg`,
  role: "assistant",
  content,
  createdAt: new Date().toISOString(),
  ...(boundaryId
    ? {
        compactBoundary: {
          boundaryId,
          strategy: "auto_compact" as const,
          createdAt: new Date().toISOString(),
        },
      }
    : {}),
});

describe("projectApiView", () => {
  it("projects from latest compact boundary", () => {
    const canonical = [
      makeCanonical("a", "old"),
      makeCanonical("b", "boundary-1", "b1"),
      makeCanonical("c", "middle"),
      makeCanonical("d", "boundary-2", "b2"),
      makeCanonical("e", "latest"),
    ];

    const apiMessages: AgentMessage[] = canonical.map(({ messageId: _messageId, ...m }) => m);

    const projected = projectApiView(apiMessages, canonical);

    expect(projected.apiView.map((m) => m.id)).toEqual(["d", "e"]);
  });

  it("restores summary from preserved segment store when missing", () => {
    const canonical = [
      makeCanonical("boundary", "boundary", "b1"),
      {
        ...makeCanonical("tail", "tail"),
        preservedSegmentRef: {
          segmentId: "s1",
          digest: "d1",
        },
      },
    ];
    const apiMessages: AgentMessage[] = canonical.map(({ messageId: _messageId, ...m }) => m);
    const state = initialContextRuntimeState();
    state.preservedSegments["s1"] = {
      digest: "d1",
      summary: "restored summary body",
      messageIds: ["a", "b"],
      createdAt: new Date().toISOString(),
    };
    canonical[0]!.preservedSegmentRef = { segmentId: "s1", digest: "d1" };

    const projected = projectApiView(apiMessages, canonical, state);
    expect(projected.canonical.some((m) => m.id.startsWith("restored_summary_"))).toBe(true);
  });
});

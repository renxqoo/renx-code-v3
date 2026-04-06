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

  it("keeps the compact boundary ahead of a restored summary in API view order", () => {
    const state = initialContextRuntimeState();
    state.preservedSegments["s1"] = {
      digest: "d1",
      summary: "restored summary body",
      messageIds: ["a", "b"],
      createdAt: new Date().toISOString(),
    };
    const canonical = [
      {
        ...makeCanonical("boundary", "boundary", "b1"),
        preservedSegmentRef: {
          segmentId: "s1",
          digest: "d1",
        },
      },
      {
        ...makeCanonical("tail", "tail"),
        preservedSegmentRef: {
          segmentId: "s1",
          digest: "d1",
        },
      },
    ];
    const apiMessages: AgentMessage[] = canonical.map(({ messageId: _messageId, ...m }) => m);

    const projected = projectApiView(apiMessages, canonical, state);

    expect(projected.apiView.map((m) => m.id).slice(0, 3)).toEqual([
      "boundary",
      "restored_summary_s1",
      "tail",
    ]);
  });

  it("does not re-insert restored summary when canonical already contains one", () => {
    const state = initialContextRuntimeState();
    state.preservedSegments["s1"] = {
      digest: "d1",
      summary: "restored summary body",
      messageIds: ["a", "b"],
      createdAt: new Date().toISOString(),
    };
    const canonical = [
      {
        ...makeCanonical("boundary", "boundary", "b1"),
        preservedSegmentRef: {
          segmentId: "s1",
          digest: "d1",
        },
      },
      {
        id: "restored_summary_s1",
        messageId: "restored_summary_s1",
        role: "system" as const,
        content: "[Restored Compact Summary:s1]\nrestored summary body",
        createdAt: new Date().toISOString(),
        source: "framework" as const,
        preservedSegmentRef: {
          segmentId: "s1",
          digest: "d1",
        },
      },
      makeCanonical("tail", "tail"),
    ];
    const apiMessages: AgentMessage[] = canonical.map(({ messageId: _messageId, ...m }) => m);

    const projected = projectApiView(apiMessages, canonical, state);
    expect(projected.canonical.filter((m) => m.id === "restored_summary_s1")).toHaveLength(1);
    expect(projected.apiView.filter((m) => m.id === "restored_summary_s1")).toHaveLength(1);
  });

  it("relinks preserved tail messages from stored segment snapshots when latest boundary tail is missing", () => {
    const state = initialContextRuntimeState();
    state.preservedSegments["s1"] = {
      digest: "d1",
      summary: "restored summary body",
      messageIds: ["a", "b"],
      createdAt: new Date().toISOString(),
      messages: [
        {
          ...makeCanonical("tail_1", "tail one"),
          preservedSegmentRef: {
            segmentId: "s1",
            digest: "d1",
          },
        },
        {
          ...makeCanonical("tail_2", "tail two"),
          preservedSegmentRef: {
            segmentId: "s1",
            digest: "d1",
          },
        },
      ],
    } as never;
    const canonical = [
      {
        ...makeCanonical("boundary", "boundary", "b1"),
        preservedSegmentRef: {
          segmentId: "s1",
          digest: "d1",
        },
        metadata: {
          preservedSegmentRelink: {
            headMessageId: "tail_1",
            anchorMessageId: "restored_summary_s1",
            tailMessageId: "tail_2",
          },
        },
      },
    ];
    const apiMessages: AgentMessage[] = canonical.map(({ messageId: _messageId, ...m }) => m);

    const projected = projectApiView(apiMessages, canonical, state);

    expect(projected.canonical.map((m) => m.id)).toEqual([
      "boundary",
      "restored_summary_s1",
      "tail_1",
      "tail_2",
    ]);
    expect(projected.apiView.map((m) => m.id)).toEqual([
      "boundary",
      "restored_summary_s1",
      "tail_1",
      "tail_2",
    ]);
  });
});

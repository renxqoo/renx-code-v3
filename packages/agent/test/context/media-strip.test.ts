import { describe, expect, it } from "vitest";

import type { AgentMessage } from "@renx/model";

import { stripMediaFromMessages } from "../../src/context/media-strip";

describe("stripMediaFromMessages", () => {
  it("replaces markdown images and documents with placeholders", () => {
    const messages: AgentMessage[] = [
      {
        id: "m1",
        role: "user",
        createdAt: new Date().toISOString(),
        content: "look ![img](https://a.com/a.png) and [doc](https://a.com/spec.pdf)",
      },
    ];

    const stripped = stripMediaFromMessages(messages);
    expect(stripped[0]?.content).toContain("[image]");
    expect(stripped[0]?.content).toContain("[document]");
    expect(stripped[0]?.metadata?.["mediaStripped"]).toBe(true);
  });
});

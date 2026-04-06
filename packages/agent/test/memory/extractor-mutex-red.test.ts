import { describe, expect, it } from "vitest";

import { hasMemoryWritesSince } from "../../src/memory/extractor/mutex";

describe("hasMemoryWritesSince", () => {
  const isAutoMemPath = (path: string) => path.startsWith("/mem/");

  it("returns false when no memory writes exist", () => {
    const messages = [
      { type: "user", uuid: "u1", content: "hello" },
      { type: "assistant", uuid: "a1", content: [{ type: "text", text: "hi" }] },
    ];

    expect(hasMemoryWritesSince(messages, undefined, isAutoMemPath)).toBe(false);
  });

  it("returns true when assistant wrote to memory path", () => {
    const messages = [
      { type: "user", uuid: "u1", content: "hello" },
      {
        type: "assistant",
        uuid: "a1",
        content: [
          { type: "text", text: "saving" },
          { type: "tool_use", name: "Write", input: { file_path: "/mem/role.md", content: "..." } },
        ],
      },
    ];

    expect(hasMemoryWritesSince(messages, undefined, isAutoMemPath)).toBe(true);
  });

  it("returns false when write is to non-memory path", () => {
    const messages = [
      {
        type: "assistant",
        uuid: "a1",
        content: [
          {
            type: "tool_use",
            name: "Write",
            input: { file_path: "/src/index.ts", content: "..." },
          },
        ],
      },
    ];

    expect(hasMemoryWritesSince(messages, undefined, isAutoMemPath)).toBe(false);
  });

  it("only checks messages after sinceUuid", () => {
    const messages = [
      {
        type: "assistant",
        uuid: "a1",
        content: [
          { type: "tool_use", name: "Write", input: { file_path: "/mem/role.md", content: "..." } },
        ],
      },
      { type: "user", uuid: "u2", content: "next" },
      {
        type: "assistant",
        uuid: "a2",
        content: [{ type: "text", text: "no writes" }],
      },
    ];

    // Start after a1 — the memory write at a1 should be ignored
    expect(hasMemoryWritesSince(messages, "a1", isAutoMemPath)).toBe(false);
  });

  it("returns false for non-array content", () => {
    const messages = [{ type: "assistant", uuid: "a1", content: "plain string content" }];

    expect(hasMemoryWritesSince(messages, undefined, isAutoMemPath)).toBe(false);
  });
});

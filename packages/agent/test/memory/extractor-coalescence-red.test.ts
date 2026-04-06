import { describe, expect, it } from "vitest";

import { CoalescenceBuffer } from "../../src/memory/extractor/coalescence";

describe("CoalescenceBuffer", () => {
  it("stores and consumes pending context", () => {
    const buf = new CoalescenceBuffer<string>();

    expect(buf.hasPending).toBe(false);

    buf.stash("context-1");
    expect(buf.hasPending).toBe(true);

    const consumed = buf.consume();
    expect(consumed).toBe("context-1");
    expect(buf.hasPending).toBe(false);
  });

  it("consume returns undefined when empty", () => {
    const buf = new CoalescenceBuffer<string>();
    expect(buf.consume()).toBeUndefined();
  });

  it("stash overwrites previous pending context", () => {
    const buf = new CoalescenceBuffer<string>();

    buf.stash("first");
    buf.stash("second");
    expect(buf.consume()).toBe("second");
  });
});

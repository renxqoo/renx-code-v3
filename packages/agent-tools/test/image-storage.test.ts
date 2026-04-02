import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { detectImageFromStdout, spillTextIfLarge } from "../src/index";

describe("detectImageFromStdout", () => {
  it("detects PNG magic", () => {
    const buf = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2]);
    const s = Buffer.from(buf).toString("latin1");
    const d = detectImageFromStdout(s);
    expect(d?.mime).toBe("image/png");
    expect(d?.ext).toBe("png");
  });
});

describe("spillTextIfLarge", () => {
  it("writes overflow to disk", () => {
    const long = "x".repeat(120_000);
    const r = spillTextIfLarge(long, {
      maxInlineChars: 1000,
      previewChars: 100,
      filePrefix: "test-spill",
      resultsDir: tmpdir(),
    });
    expect(r.truncated).toBe(true);
    expect(r.artifactPath?.length).toBeGreaterThan(0);
    expect(r.content.length).toBeLessThan(long.length);
  });
});

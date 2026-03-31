import { describe, expect, it } from "vitest";

import { isTerminalStatus, shouldPause } from "../src/helpers";

describe("isTerminalStatus", () => {
  it("returns true for 'completed'", () => {
    expect(isTerminalStatus("completed")).toBe(true);
  });

  it("returns true for 'failed'", () => {
    expect(isTerminalStatus("failed")).toBe(true);
  });

  it("returns false for 'running'", () => {
    expect(isTerminalStatus("running")).toBe(false);
  });

  it("returns false for 'interrupted'", () => {
    expect(isTerminalStatus("interrupted")).toBe(false);
  });

  it("returns false for 'waiting_approval'", () => {
    expect(isTerminalStatus("waiting_approval")).toBe(false);
  });
});

describe("shouldPause", () => {
  it("returns true for 'waiting_approval'", () => {
    expect(shouldPause("waiting_approval")).toBe(true);
  });

  it("returns true for 'interrupted'", () => {
    expect(shouldPause("interrupted")).toBe(true);
  });

  it("returns false for 'running'", () => {
    expect(shouldPause("running")).toBe(false);
  });

  it("returns false for 'completed'", () => {
    expect(shouldPause("completed")).toBe(false);
  });

  it("returns false for 'failed'", () => {
    expect(shouldPause("failed")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { TurnThrottle } from "../../src/memory/extractor/throttle";

describe("TurnThrottle", () => {
  it("runs immediately when interval is 1", () => {
    const throttle = new TurnThrottle(1);
    expect(throttle.shouldRun()).toBe(true);
  });

  it("skips when below interval threshold", () => {
    const throttle = new TurnThrottle(3);
    expect(throttle.shouldRun()).toBe(false);
    expect(throttle.shouldRun()).toBe(false);
    expect(throttle.shouldRun()).toBe(true);
  });

  it("resets counter after running", () => {
    const throttle = new TurnThrottle(2);
    expect(throttle.shouldRun()).toBe(false);
    expect(throttle.shouldRun()).toBe(true);
    // After running, cycle restarts
    expect(throttle.shouldRun()).toBe(false);
    expect(throttle.shouldRun()).toBe(true);
  });

  it("can be manually reset", () => {
    const throttle = new TurnThrottle(5);
    throttle.shouldRun(); // 1
    throttle.shouldRun(); // 2
    throttle.reset();
    // Counter is reset, need full cycle again
    expect(throttle.shouldRun()).toBe(false);
    expect(throttle.shouldRun()).toBe(false);
    expect(throttle.shouldRun()).toBe(false);
    expect(throttle.shouldRun()).toBe(false);
    expect(throttle.shouldRun()).toBe(true);
  });
});

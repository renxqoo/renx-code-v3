import { describe, expect, it } from "vitest";

import { DreamGate } from "../../src/memory/dream/gate";

const HOUR_MS = 3_600_000;
const NOW = 1_000_000_000_000; // realistic timestamp

describe("DreamGate", () => {
  it("opens when all three gates pass", () => {
    const gate = new DreamGate({
      minHours: 24,
      minSessions: 5,
      scanIntervalMs: 0,
      getNow: () => NOW,
    });

    const lastConsolidatedAt = NOW - 25 * HOUR_MS;
    expect(gate.shouldRun(lastConsolidatedAt, 6)).toBe(true);
  });

  it("blocks when time gate fails (not enough hours)", () => {
    const gate = new DreamGate({
      minHours: 24,
      minSessions: 5,
      scanIntervalMs: 0,
      getNow: () => NOW,
    });

    const lastConsolidatedAt = NOW - 10 * HOUR_MS;
    expect(gate.shouldRun(lastConsolidatedAt, 10)).toBe(false);
  });

  it("blocks when session gate fails (not enough sessions)", () => {
    const gate = new DreamGate({
      minHours: 24,
      minSessions: 5,
      scanIntervalMs: 0,
      getNow: () => NOW,
    });

    const lastConsolidatedAt = NOW - 30 * HOUR_MS;
    expect(gate.shouldRun(lastConsolidatedAt, 3)).toBe(false);
  });

  it("passes with exactly threshold values", () => {
    const gate = new DreamGate({
      minHours: 24,
      minSessions: 5,
      scanIntervalMs: 0,
      getNow: () => NOW,
    });

    const lastConsolidatedAt = NOW - 24 * HOUR_MS;
    expect(gate.shouldRun(lastConsolidatedAt, 5)).toBe(true);
  });

  it("scan throttle blocks repeated scans", () => {
    let now = NOW;
    const gate = new DreamGate({
      minHours: 24,
      minSessions: 5,
      scanIntervalMs: 600_000, // 10 minutes
      getNow: () => now,
    });

    const lastConsolidatedAt = NOW - 25 * HOUR_MS;

    // First call passes (lastSessionScanAt starts at 0, so scan gap is huge)
    expect(gate.shouldRun(lastConsolidatedAt, 10)).toBe(true);

    // Immediately calling again — scan gap is 0, should be throttled
    expect(gate.shouldRun(lastConsolidatedAt, 10)).toBe(false);

    // After 10 minutes pass, should work again
    now = NOW + 600_001;
    expect(gate.shouldRun(lastConsolidatedAt, 10)).toBe(true);
  });

  it("skips when disabled", () => {
    const gate = new DreamGate({
      minHours: 24,
      minSessions: 5,
      enabled: false,
      scanIntervalMs: 0,
      getNow: () => NOW,
    });

    expect(gate.shouldRun(0, 100)).toBe(false);
  });
});

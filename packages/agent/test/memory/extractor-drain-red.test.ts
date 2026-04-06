import { describe, expect, it } from "vitest";

import { drainPendingExtractions } from "../../src/memory/extractor/drain";

describe("drainPendingExtractions", () => {
  it("resolves immediately when set is empty", async () => {
    const set = new Set<Promise<void>>();
    await drainPendingExtractions(set);
    // Should not hang
  });

  it("waits for all promises to settle", async () => {
    const set = new Set<Promise<void>>();
    let resolveA: () => void;
    let resolveB: () => void;

    set.add(
      new Promise<void>((r) => {
        resolveA = r;
      }),
    );
    set.add(
      new Promise<void>((r) => {
        resolveB = r;
      }),
    );

    const drainPromise = drainPendingExtractions(set);

    resolveA!();
    resolveB!();

    await drainPromise;
  });

  it("handles rejected promises gracefully", async () => {
    const set = new Set<Promise<void>>();
    set.add(Promise.reject(new Error("test error")));

    await drainPendingExtractions(set);
    // Should not throw
  });

  it("times out when promises take too long", async () => {
    const set = new Set<Promise<void>>();
    set.add(new Promise<void>(() => {})); // Never resolves

    const start = Date.now();
    await drainPendingExtractions(set, 100);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(500);
  });
});

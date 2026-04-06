import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ConsolidationLock } from "../../src/memory/dream/lock";

describe("ConsolidationLock", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "renx-dream-lock-"));
    tempDirs.push(dir);
    return dir;
  }

  it("returns 0 when no lock file exists", async () => {
    const lock = new ConsolidationLock(tmpDir());
    const mtime = await lock.readLastConsolidatedAt();
    expect(mtime).toBe(0);
  });

  it("acquires lock and returns prior mtime", async () => {
    const dir = tmpDir();
    const lock = new ConsolidationLock(dir);

    const priorMtime = await lock.tryAcquire();
    // No prior lock, so returns 0
    expect(priorMtime).toBe(0);

    // Now reading should return a non-zero mtime
    const mtime = await lock.readLastConsolidatedAt();
    expect(mtime).toBeGreaterThan(0);
  });

  it("prevents double acquire from same process", async () => {
    const dir = tmpDir();
    const lock = new ConsolidationLock(dir);

    const first = await lock.tryAcquire();
    expect(first).toBe(0);

    // Second acquire should return null (already held)
    const second = await lock.tryAcquire();
    expect(second).toBeNull();
  });

  it("rollback restores prior mtime", async () => {
    const dir = tmpDir();
    const lock = new ConsolidationLock(dir);

    // Acquire first
    await lock.tryAcquire();
    const acquiredMtime = await lock.readLastConsolidatedAt();

    // Rollback to 0 (delete)
    await lock.rollback(0);
    const afterRollback = await lock.readLastConsolidatedAt();
    expect(afterRollback).toBe(0);
  });

  it("recordConsolidation updates lock file", async () => {
    const dir = tmpDir();
    const lock = new ConsolidationLock(dir);

    await lock.recordConsolidation();
    const mtime = await lock.readLastConsolidatedAt();
    expect(mtime).toBeGreaterThan(0);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FileMemoryDirStore, ensureMemoryDirExists } from "../../src/memory/memdir/store";
import {
  getAutoMemPath,
  isAutoMemPath,
  isAutoMemoryEnabled,
  validateMemoryPath,
} from "../../src/memory/memdir/paths";
import {
  truncateEntrypointContent,
  formatMemoryManifest,
} from "../../src/memory/memdir/entrypoint";
import { memoryAgeDays, memoryFreshnessText } from "../../src/memory/freshness";
import { buildExtractAutoOnlyPrompt, buildConsolidationPrompt } from "../../src/memory/prompts";
import { TurnThrottle } from "../../src/memory/extractor/throttle";
import { CoalescenceBuffer } from "../../src/memory/extractor/coalescence";
import { hasMemoryWritesSince } from "../../src/memory/extractor/mutex";
import { drainPendingExtractions } from "../../src/memory/extractor/drain";
import { DreamGate } from "../../src/memory/dream/gate";
import { ConsolidationLock } from "../../src/memory/dream/lock";
import { getDailyLogPath, appendToDailyLog } from "../../src/memory/kairos/log";
import {
  detectSessionFileType,
  isAutoMemFile,
  isAutoManagedMemoryFile,
} from "../../src/memory/detection";
import { sanitizePathKey } from "../../src/memory/team-sync-security";
import { buildRememberPrompt } from "../../src/memory/remember-skill";

describe("memory integration", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "renx-integration-"));
    tempDirs.push(dir);
    return dir;
  }

  it("full memdir lifecycle: save → load → recall → freshness → prompt", async () => {
    const dir = tmpDir();

    // 1. Ensure dir exists
    await ensureMemoryDirExists(dir);

    // 2. Write memory files
    await writeFile(
      join(dir, "user_role.md"),
      `---
name: user_role
description: Backend engineer
type: user
---
User prefers Go and functional patterns.`,
    );

    await writeFile(
      join(dir, "feedback_testing.md"),
      `---
name: feedback_testing
description: Use real databases
type: feedback
---
Integration tests must hit a real database.
Why: prior incident where mock/prod divergence masked a broken migration.
How to apply: always connect to a real test database.`,
    );

    // 3. Load via FileMemoryDirStore
    const store = new FileMemoryDirStore(dir);
    const snapshot = await store.load("project", "default");

    expect(snapshot).not.toBeNull();
    expect(snapshot!.semantic.entries.length).toBe(2);

    // 4. Check freshness
    const roleEntry = snapshot!.semantic.entries.find((e) => e.title === "user_role")!;
    const ageDays = memoryAgeDays(new Date(roleEntry.updatedAt!).getTime());
    expect(ageDays).toBe(0);
    expect(memoryFreshnessText(new Date(roleEntry.updatedAt!).getTime())).toBe("");

    // 5. Build extraction prompt
    const manifest = formatMemoryManifest([
      {
        filename: "user_role.md",
        filePath: join(dir, "user_role.md"),
        mtimeMs: Date.now(),
        description: "Backend engineer",
        type: "user",
      },
    ]);
    const extractPrompt = buildExtractAutoOnlyPrompt(10, manifest);
    expect(extractPrompt).toContain("memory extraction subagent");
    expect(extractPrompt).toContain("user_role.md");

    // 6. Build consolidation prompt
    const dreamPrompt = buildConsolidationPrompt(dir, "/transcripts", "");
    expect(dreamPrompt).toContain("Phase 1");
    expect(dreamPrompt).toContain(dir);
  });

  it("extractor pipeline: throttle → coalescence → mutex → drain", async () => {
    // 1. Throttle
    const throttle = new TurnThrottle(2);
    expect(throttle.shouldRun()).toBe(false);
    expect(throttle.shouldRun()).toBe(true);

    // 2. Coalescence
    const buf = new CoalescenceBuffer<{ ctx: string }>();
    expect(buf.hasPending).toBe(false);
    buf.stash({ ctx: "latest" });
    expect(buf.hasPending).toBe(true);
    const consumed = buf.consume();
    expect(consumed!.ctx).toBe("latest");
    expect(buf.hasPending).toBe(false);

    // 3. Mutex — no writes
    expect(
      hasMemoryWritesSince(
        [{ type: "assistant", uuid: "a1", content: [{ type: "text", text: "hi" }] }],
        undefined,
        (p) => p.startsWith("/mem/"),
      ),
    ).toBe(false);

    // 4. Drain with empty set
    const inFlight = new Set<Promise<void>>();
    await drainPendingExtractions(inFlight, 100);
  });

  it("dream gate + lock lifecycle", async () => {
    const dir = tmpDir();
    const now = 1_000_000_000_000;

    // 1. Gate blocks with insufficient time
    const gate = new DreamGate({
      minHours: 24,
      minSessions: 5,
      scanIntervalMs: 0,
      getNow: () => now,
    });
    expect(gate.shouldRun(now - 10 * 3_600_000, 10)).toBe(false);

    // 2. Gate passes with enough time and sessions
    expect(gate.shouldRun(now - 25 * 3_600_000, 6)).toBe(true);

    // 3. Lock acquire + read + rollback
    const lock = new ConsolidationLock(dir);
    const prior = await lock.tryAcquire();
    expect(prior).toBe(0);

    const mtime = await lock.readLastConsolidatedAt();
    expect(mtime).toBeGreaterThan(0);

    await lock.rollback(0);
    const afterRollback = await lock.readLastConsolidatedAt();
    expect(afterRollback).toBe(0);
  });

  it("kairos log write + detection", async () => {
    const dir = tmpDir();
    const date = new Date("2026-04-06");

    // 1. Write kairos log
    await appendToDailyLog(dir, date, "User prefers dark theme");
    const logPath = getDailyLogPath(dir, date);
    expect(logPath).toMatch(/2026[/\\]04[/\\]2026-04-06\.md/);

    // 2. Detection: session file types
    expect(detectSessionFileType("/home/.claude/session-memory/notes.md")).toBe("session_memory");
    expect(detectSessionFileType("/home/user/src/main.ts")).toBeNull();

    // 3. Auto mem file detection
    expect(isAutoMemFile(join(dir, "role.md"), dir)).toBe(true);
    expect(isAutoMemFile("/other/path/file.md", dir)).toBe(false);

    // 4. Security: sanitize path key
    expect(sanitizePathKey("valid-key.md")).toBe("valid-key.md");
    expect(() => sanitizePathKey("%2e%2e%2fpasswd")).toThrow();
  });

  it("remember skill produces valid prompt", () => {
    const prompt = buildRememberPrompt("Focus on project memories");
    expect(prompt).toContain("Memory Review");
    expect(prompt).toContain("Focus on project memories");
    expect(prompt).toContain("CLAUDE.md");
    expect(prompt).toContain("Do NOT modify files");
  });

  it("path validation rejects dangerous inputs", () => {
    expect(() => validateMemoryPath("relative/path.md")).toThrow();
    expect(() => validateMemoryPath("/valid/path\0.md")).toThrow();
    expect(() => validateMemoryPath("\\\\server\\share\\file.md")).toThrow();
  });

  it("path resolution produces correct structure", () => {
    const path = getAutoMemPath({
      memoryBase: "/home/.claude",
      projectRoot: "/home/projects/my-app",
    });
    expect(path).toContain("projects");
    expect(path).toContain("memory");
  });
});

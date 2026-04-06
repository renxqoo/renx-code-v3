/**
 * PID-based consolidation lock.
 *
 * 1:1 replicate of consolidationLock.ts from claude-code-source.
 *
 * The lock file lives inside the memory directory. Its mtime IS
 * lastConsolidatedAt. Body is the holder's PID.
 *
 * Stale threshold: 1 hour (HOLDER_STALE_MS).
 * Stale past this even if PID is live (PID reuse guard).
 */

import { mkdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LOCK_FILE = ".consolidate-lock";
const HOLDER_STALE_MS = 60 * 60 * 1000;

export class ConsolidationLock {
  constructor(private readonly memoryDir: string) {}

  private lockPath(): string {
    return join(this.memoryDir, LOCK_FILE);
  }

  /**
   * mtime of the lock file = lastConsolidatedAt. 0 if absent.
   */
  async readLastConsolidatedAt(): Promise<number> {
    try {
      const s = await stat(this.lockPath());
      return s.mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * Acquire: write PID to lock file. Returns the prior mtime
   * (for rollback), or null if blocked/lost race.
   */
  async tryAcquire(): Promise<number | null> {
    const lockFile = this.lockPath();

    // Parallel stat + read for atomic mtime/PID snapshot (matching reference)
    let mtimeMs: number | undefined;
    let holderPid: number | undefined;

    try {
      const [stats, raw] = await Promise.all([stat(lockFile), readFile(lockFile, "utf8")]);
      mtimeMs = stats.mtimeMs;
      holderPid = parseInt(raw.trim(), 10);
      if (!Number.isFinite(holderPid)) holderPid = undefined;
    } catch {
      // ENOENT — no prior lock
    }

    if (mtimeMs !== undefined && Date.now() - mtimeMs < HOLDER_STALE_MS) {
      // Check if holder PID is alive
      if (holderPid !== undefined && isProcessRunning(holderPid)) {
        return null;
      }
    }

    // Memory dir may not exist yet
    await mkdir(this.memoryDir, { recursive: true });
    await writeFile(lockFile, String(process.pid));

    // Verify we won the race
    try {
      const verify = await readFile(lockFile, "utf8");
      if (parseInt(verify.trim(), 10) !== process.pid) return null;
    } catch {
      return null;
    }

    return mtimeMs ?? 0;
  }

  /**
   * Rewind mtime to pre-acquire value after failed consolidation.
   * priorMtime 0 → unlink (restore no-file state).
   */
  async rollback(priorMtime: number): Promise<void> {
    const path = this.lockPath();
    try {
      if (priorMtime === 0) {
        await unlink(path);
        return;
      }
      await writeFile(path, "");
      const t = priorMtime / 1000;
      await utimes(path, t, t);
    } catch {
      // Best-effort rollback
    }
  }

  /**
   * Record consolidation from manual /dream. Stamp lock file.
   */
  async recordConsolidation(): Promise<void> {
    try {
      await mkdir(this.memoryDir, { recursive: true });
      await writeFile(this.lockPath(), String(process.pid));
    } catch {
      // Best-effort
    }
  }
}

/**
 * Check if a process is running. Cross-platform.
 */
function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 checks existence without killing
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

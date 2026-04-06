/**
 * Dream executor: orchestrates the full auto-dream consolidation cycle.
 *
 * 1:1 replicate of autoDream.ts from claude-code-source but adapted to
 * the SDK architecture where the runner is injected rather than imported.
 *
 * Flow:
 *   1. Check gate (time + sessions)
 *   2. Try acquire lock
 *   3. Build consolidation prompt
 *   4. Run forked agent via DreamRunner
 *   5. Record consolidation on success
 *   6. Rollback lock on failure
 */

import { buildConsolidationPrompt } from "../prompts/dream";
import { DreamGate, type DreamGateConfig } from "./gate";
import { ConsolidationLock } from "./lock";
import type { SessionScanner } from "./session-scanner";

// ── Config ──────────────────────────────────────────────────────────

export interface DreamExecutorConfig {
  minHours: number; // default 24
  minSessions: number; // default 5
  enabled: boolean; // default true
  scanIntervalMs: number; // default 10 * 60 * 1000
}

const DEFAULT_CONFIG: DreamExecutorConfig = {
  minHours: 24,
  minSessions: 5,
  enabled: true,
  scanIntervalMs: 10 * 60 * 1000,
};

// ── Context ─────────────────────────────────────────────────────────

export interface DreamContext {
  memoryDir: string;
  transcriptDir: string;
  currentSessionId?: string;
  extraContext?: string;
}

// ── Runner ──────────────────────────────────────────────────────────

export interface DreamRunner {
  run(params: {
    systemPrompt: string;
    messages: Array<{ role: string; content: string }>;
    maxTurns: number;
    canUseTool: (toolName: string, input: unknown) => boolean | string;
  }): Promise<{ success: boolean; text?: string }>;
}

/**
 * Read-only Bash command prefixes. These are the commands the dream agent
 * is allowed to run — only non-destructive inspection commands.
 */
const ALLOWED_BASH_PREFIXES = [
  "cat ",
  "head ",
  "tail ",
  "ls ",
  "find ",
  "wc ",
  "grep ",
  "rg ",
  "git log",
  "git diff",
  "git show",
  "git status",
  "git rev-parse",
  "pwd",
  "echo ",
  "file ",
  "md5sum ",
  "sha256sum ",
  "stat ",
  "readlink ",
  "which ",
  "dirname ",
  "basename ",
];

// ── Executor ────────────────────────────────────────────────────────

const DREAM_MAX_TURNS = 30;

export class DreamExecutor {
  private readonly config: DreamExecutorConfig;
  private readonly runner: DreamRunner;
  private readonly sessionScanner: SessionScanner;
  private readonly gate: DreamGate;
  private running = false;

  constructor(
    config: Partial<DreamExecutorConfig>,
    runner: DreamRunner,
    sessionScanner: SessionScanner,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.runner = runner;
    this.sessionScanner = sessionScanner;

    const gateConfig: DreamGateConfig = {
      minHours: this.config.minHours,
      minSessions: this.config.minSessions,
      enabled: this.config.enabled,
      scanIntervalMs: this.config.scanIntervalMs,
    };
    this.gate = new DreamGate(gateConfig);
  }

  /**
   * Execute one dream consolidation cycle.
   *
   * Returns true if consolidation ran and succeeded.
   * Returns false if gated, lock was held, or consolidation failed.
   */
  async execute(context: DreamContext): Promise<boolean> {
    if (this.running) return false;

    const lock = new ConsolidationLock(context.memoryDir);

    // ── Phase 1: Gate check ───────────────────────────────────────
    const lastConsolidatedAt = await lock.readLastConsolidatedAt();
    const newSessionCount = await this.sessionScanner.countNewSessionsSince(
      lastConsolidatedAt,
      context.transcriptDir,
      context.currentSessionId,
    );

    if (!this.gate.shouldRun(lastConsolidatedAt, newSessionCount)) {
      return false;
    }

    // ── Phase 2: Acquire lock ─────────────────────────────────────
    const priorMtime = await lock.tryAcquire();
    if (priorMtime === null) {
      // Another process holds the lock
      return false;
    }

    this.running = true;

    try {
      // ── Phase 3: Build prompt ───────────────────────────────────
      const systemPrompt = buildConsolidationPrompt(
        context.memoryDir,
        context.transcriptDir,
        context.extraContext ?? "",
      );

      // Seed message tells the agent to begin the dream
      const messages: Array<{ role: string; content: string }> = [
        {
          role: "user",
          content: "Begin dream consolidation now. Follow the phases in your system prompt.",
        },
      ];

      // ── Phase 4: Run forked agent ───────────────────────────────
      const result = await this.runner.run({
        systemPrompt,
        messages,
        maxTurns: DREAM_MAX_TURNS,
        canUseTool: (toolName: string, input: unknown): boolean | string => {
          // Read-only tools: always allowed
          if (toolName === "Read" || toolName === "Grep" || toolName === "Glob") {
            return true;
          }

          // Bash: only read-only commands allowed
          if (toolName === "Bash") {
            const cmd =
              typeof input === "object" && input !== null && "command" in input
                ? String((input as Record<string, unknown>).command)
                : "";
            const trimmed = cmd.trim();
            if (ALLOWED_BASH_PREFIXES.some((p) => trimmed.startsWith(p))) {
              return true;
            }
            return "Bash command is not read-only. Only inspection commands are allowed during dream consolidation.";
          }

          // Edit/Write: only files within the memory directory
          if (toolName === "Edit" || toolName === "Write") {
            const filePath =
              typeof input === "object" && input !== null
                ? String((input as Record<string, unknown>).file_path ?? "")
                : "";
            const normalizedFile = filePath.split("\\").join("/");
            const normalizedMem = context.memoryDir.split("\\").join("/");
            if (normalizedFile.startsWith(normalizedMem)) {
              return true;
            }
            return "Write/Edit is only allowed within the memory directory during dream consolidation.";
          }

          return `Tool "${toolName}" is not allowed during dream consolidation.`;
        },
      });

      // ── Phase 5: Record or rollback ─────────────────────────────
      if (result.success) {
        await lock.recordConsolidation();
        return true;
      }

      // Consolidation failed — rollback lock to prior state
      await lock.rollback(priorMtime);
      return false;
    } catch {
      // Unexpected error — rollback lock
      await lock.rollback(priorMtime);
      return false;
    } finally {
      this.running = false;
    }
  }

  /**
   * Drain: wait for any in-flight execution to finish.
   * Call during shutdown to avoid partial writes.
   */
  async drain(): Promise<void> {
    // Spin until running becomes false. In practice this is
    // short-lived since the runner respects maxTurns.
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Reset internal gate state (e.g. for testing).
   */
  reset(): void {
    this.running = false;
  }
}

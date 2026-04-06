/**
 * Triple-gate for auto-dream consolidation.
 *
 * 1:1 replicate of the gate chain from
 * claude-code-source/src/services/autoDream/autoDream.ts.
 *
 * Gate order (cheapest first):
 *   0. Enabled flag
 *   1. Time: hours since last consolidation >= minHours
 *   2. Session: new session count >= minSessions
 */

export interface DreamGateConfig {
  minHours: number;
  minSessions: number;
  enabled?: boolean;
  getNow?: () => number;
  scanIntervalMs?: number;
}

export class DreamGate {
  private readonly minHours: number;
  private readonly minSessions: number;
  private readonly enabled: boolean;
  private readonly getNow: () => number;
  private readonly scanIntervalMs: number;
  private lastSessionScanAt = 0;

  constructor(config: DreamGateConfig) {
    this.minHours = config.minHours;
    this.minSessions = config.minSessions;
    this.enabled = config.enabled ?? true;
    this.getNow = config.getNow ?? (() => Date.now());
    this.scanIntervalMs = config.scanIntervalMs ?? 10 * 60 * 1000;
  }

  /**
   * Returns true if all gates pass:
   * 1. Enabled gate
   * 2. Time gate (hours since last consolidation >= minHours)
   * 3. Scan throttle (not scanned too recently)
   * 4. Session gate (session count >= minSessions)
   */
  shouldRun(lastConsolidatedAt: number, newSessionCount: number): boolean {
    // Gate 0: enabled
    if (!this.enabled) return false;

    // Gate 1: time
    const now = this.getNow();
    const hoursSince = (now - lastConsolidatedAt) / 3_600_000;
    if (hoursSince < this.minHours) return false;

    // Gate 2: scan throttle
    const sinceScanMs = now - this.lastSessionScanAt;
    if (sinceScanMs < this.scanIntervalMs) return false;
    this.lastSessionScanAt = now;

    // Gate 3: sessions
    if (newSessionCount < this.minSessions) return false;

    return true;
  }
}

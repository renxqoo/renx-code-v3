/**
 * Turn-based throttle for memory extraction.
 *
 * 1:1 replicate of the turnsSinceLastExtraction counter from
 * claude-code-source/src/services/extractMemories/extractMemories.ts.
 *
 * Only runs extraction every N eligible turns (default: every turn).
 * Trailing runs skip the throttle check.
 */

export class TurnThrottle {
  private turnsSinceLastRun = 0;

  constructor(private readonly interval: number = 1) {}

  /**
   * Returns true if the extraction should run this turn.
   * Increments the internal counter each call.
   *
   * 1:1 replicate of turnsSinceLastExtraction logic:
   *   turnsSinceLastExtraction++
   *   if (turnsSinceLastExtraction >= interval) { turnsSinceLastExtraction = 0; return true }
   */
  shouldRun(): boolean {
    this.turnsSinceLastRun++;
    if (this.turnsSinceLastRun >= this.interval) {
      this.turnsSinceLastRun = 0;
      return true;
    }
    return false;
  }

  /**
   * Reset the counter (e.g., after a successful extraction).
   */
  reset(): void {
    this.turnsSinceLastRun = 0;
  }
}

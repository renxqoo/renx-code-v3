/**
 * Trailing-run coalescence buffer.
 *
 * 1:1 replicate of the pendingContext pattern from
 * claude-code-source/src/services/extractMemories/extractMemories.ts.
 *
 * When an extraction is already in progress, new calls stash their context.
 * After the current extraction finishes, the stashed context is consumed
 * for a trailing run. Only the latest stashed context matters.
 */

export class CoalescenceBuffer<T> {
  private pending: T | undefined;

  /**
   * Stash a context for a trailing run. Overwrites any previously
   * stashed context — only the latest matters.
   */
  stash(context: T): void {
    this.pending = context;
  }

  /**
   * Consume and return the stashed context, clearing the buffer.
   * Returns undefined if nothing is stashed.
   */
  consume(): T | undefined {
    const ctx = this.pending;
    this.pending = undefined;
    return ctx;
  }

  /**
   * Whether there is a pending context waiting for a trailing run.
   */
  get hasPending(): boolean {
    return this.pending !== undefined;
  }
}

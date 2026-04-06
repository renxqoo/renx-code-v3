/**
 * Drain in-flight extraction promises with soft timeout.
 *
 * 1:1 replicate of drainPendingExtraction() from
 * claude-code-source/src/services/extractMemories/extractMemories.ts.
 *
 * Awaits all in-flight extraction promises, with a soft timeout.
 * Used at shutdown to ensure forked agents complete before process exit.
 */

/**
 * Drain all promises in the set with a soft timeout.
 * Completed promises are removed from the set by the caller.
 *
 * Uses Promise.all + catch (matching reference) which returns
 * as soon as the first promise rejects, rather than waiting
 * for all to settle.
 *
 * @param inFlight - Set of in-flight extraction promises
 * @param timeoutMs - Maximum time to wait (default 60s)
 */
export async function drainPendingExtractions(
  inFlight: Set<Promise<void>>,
  timeoutMs: number = 60_000,
): Promise<void> {
  if (inFlight.size === 0) return;

  await Promise.race([
    Promise.all(inFlight).catch(() => {
      // Swallow rejections — best-effort drain
    }),
    new Promise<void>((r) => {
      const timer = setTimeout(r, timeoutMs);
      if ("unref" in timer) {
        (timer as ReturnType<typeof setTimeout> & { unref(): void }).unref();
      }
    }),
  ]);
}

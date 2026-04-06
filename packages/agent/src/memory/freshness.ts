/**
 * Memory freshness / staleness tracking.
 *
 * 1:1 replicate of claude-code-source/src/memdir/memoryAge.ts.
 *
 * Models are poor at date arithmetic — a raw ISO timestamp doesn't
 * trigger staleness reasoning the way "47 days ago" does.
 */

/**
 * Days elapsed since mtime. Floor-rounded — 0 for today, 1 for
 * yesterday, 2+ for older. Negative inputs (future mtime, clock skew)
 * clamp to 0.
 */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
}

/**
 * Human-readable age string.
 */
export function memoryAge(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs);
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  return `${d} days ago`;
}

/**
 * Plain-text staleness caveat for memories >1 day old. Returns ''
 * for fresh (today/yesterday) memories.
 *
 * Motivated by user reports of stale code-state memories (file:line
 * citations to code that has since changed) being asserted as fact.
 */
export function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs);
  if (d <= 1) return "";
  return (
    `This memory is ${d} days old. ` +
    `Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be outdated. ` +
    `Verify against current code before asserting as fact.`
  );
}

/**
 * Per-memory staleness note wrapped in <system-reminder> tags.
 * Returns '' for memories ≤ 1 day old.
 */
export function memoryFreshnessNote(mtimeMs: number): string {
  const text = memoryFreshnessText(mtimeMs);
  if (!text) return "";
  return `<system-reminder>${text}</system-reminder>\n`;
}

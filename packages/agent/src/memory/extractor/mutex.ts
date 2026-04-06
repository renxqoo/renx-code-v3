/**
 * Memory write detection (mutual exclusion).
 *
 * 1:1 replicate of hasMemoryWritesSince() from
 * claude-code-source/src/services/extractMemories/extractMemories.ts.
 *
 * Detects whether the main agent wrote to memory files in recent messages.
 * When the main agent writes memories directly, the forked extraction is
 * skipped as redundant.
 */

export type SimpleMessage = {
  type: string;
  uuid?: string;
  content?: unknown;
};

/**
 * Returns true if any assistant message after sinceUuid contains a
 * Write/Edit tool_use block targeting a memory path.
 *
 * @param messages - Conversation messages to scan
 * @param sinceUuid - Only scan messages after this UUID. Undefined = scan all.
 * @param isMemPath - Function that returns true for auto-memory paths
 */
export function hasMemoryWritesSince(
  messages: SimpleMessage[],
  sinceUuid: string | undefined,
  isMemPath: (filePath: string) => boolean,
): boolean {
  let foundStart = sinceUuid === undefined;

  for (const message of messages) {
    if (!foundStart) {
      if (message.uuid === sinceUuid) {
        foundStart = true;
      }
      continue;
    }

    if (message.type !== "assistant") continue;

    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      const filePath = getToolUseFilePath(block);
      if (filePath !== undefined && isMemPath(filePath)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Extract file_path from a tool_use block's input, if present.
 * Returns undefined for non-Edit/Write blocks or missing file_path.
 */
function getToolUseFilePath(block: {
  type?: string;
  name?: string;
  input?: unknown;
}): string | undefined {
  if (block.type !== "tool_use") return undefined;
  if (block.name !== "Write" && block.name !== "Edit") return undefined;

  const input = block.input;
  if (typeof input === "object" && input !== null && "file_path" in input) {
    const fp = (input as { file_path: unknown }).file_path;
    return typeof fp === "string" ? fp : undefined;
  }
  return undefined;
}

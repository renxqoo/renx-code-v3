import { extname } from "node:path";

import type { AgentTool, ToolResult } from "@renx/agent";
import { createToolCapabilityProfile } from "@renx/agent";
import { z } from "zod";

import {
  assertFreshSnapshot,
  buildSnapshot,
  buildSnapshotPatch,
  buildStructuredPatch,
  getTrackedSnapshot,
  pathExists,
  readTextFileDetailed,
  resolveWorkspacePath,
  restoreLineEndings,
  writeTextAtomic,
} from "./shared";

const EDIT_TOOL_DESCRIPTION = `Performs exact string replacements in files.

Usage:
- You must use your \`Read\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file.`;

const countOccurrences = (content: string, target: string): number => {
  if (target.length === 0) return 0;
  let count = 0;
  let cursor = 0;
  while (true) {
    const index = content.indexOf(target, cursor);
    if (index === -1) return count;
    count += 1;
    cursor = index + target.length;
  }
};

export const createFileEditTool = (): AgentTool => {
  const schema = z.object({
    file_path: z.string().min(1).describe("The absolute file path to edit."),
    old_string: z.string().describe("Exact text to replace."),
    new_string: z.string().describe("Replacement text."),
    replace_all: z.boolean().optional().describe("Replace every occurrence of old_string."),
  });

  return {
    name: "Edit",
    description: EDIT_TOOL_DESCRIPTION,
    schema,
    capabilities: ["requires-filesystem-read", "requires-filesystem-write"],
    profile: createToolCapabilityProfile({
      riskLevel: "high",
      capabilityTags: ["filesystem_read", "filesystem_write"],
      sandboxExpectation: "workspace-write",
      auditCategory: "file_edit",
    }),
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    invoke: async (input, ctx): Promise<ToolResult> => {
      const parsed = schema.parse(input);
      if (parsed.old_string === parsed.new_string) {
        throw new Error("old_string and new_string are identical. No edit is required.");
      }

      const resolved = await resolveWorkspacePath(ctx, parsed.file_path);
      const replaceAll = parsed.replace_all ?? false;

      const exists = await pathExists(ctx, resolved.fullPath);

      if (!exists) {
        if (parsed.old_string !== "") {
          throw new Error(`File does not exist: ${resolved.relativePath}`);
        }
        await writeTextAtomic(ctx, resolved.fullPath, parsed.new_string);
        const createdNormalized = parsed.new_string.replaceAll("\r\n", "\n");
        const createdSnapshot = await buildSnapshot(
          ctx,
          resolved.fullPath,
          createdNormalized,
          false,
        );
        return {
          content: `Created ${resolved.relativePath}`,
          structured: {
            path: resolved.relativePath,
            operation: "create",
            originalFile: null,
            structuredPatch: buildStructuredPatch(null, createdNormalized),
          },
          statePatch: buildSnapshotPatch(ctx, createdSnapshot),
        };
      }

      if (extname(resolved.fullPath).toLowerCase() === ".ipynb") {
        throw new Error(
          `Notebook files must be changed with NotebookEdit: ${resolved.relativePath}`,
        );
      }

      const snapshot = getTrackedSnapshot(ctx, resolved.fullPath);
      if (!snapshot || snapshot.partial) {
        throw new Error("File must be fully read before it can be edited.");
      }

      const current = await readTextFileDetailed(ctx, resolved.fullPath, {
        maxReadBytes: Number.MAX_SAFE_INTEGER,
      });
      await assertFreshSnapshot(ctx, snapshot, resolved.fullPath, current.content);

      if (parsed.old_string === "") {
        if (current.content.length > 0) {
          throw new Error("old_string cannot be empty when editing a non-empty file.");
        }
        const writtenContent = restoreLineEndings(
          parsed.new_string.replaceAll("\r\n", "\n"),
          current.lineEnding,
        );
        await writeTextAtomic(ctx, resolved.fullPath, writtenContent);
        const updatedNormalized = writtenContent.replaceAll("\r\n", "\n");
        const emptySnapshot = await buildSnapshot(ctx, resolved.fullPath, updatedNormalized, false);
        return {
          content: `Updated ${resolved.relativePath}`,
          structured: {
            path: resolved.relativePath,
            operation: "update",
            replacements: 1,
            originalFile: current.content,
            structuredPatch: buildStructuredPatch(current.content, updatedNormalized),
          },
          statePatch: buildSnapshotPatch(ctx, emptySnapshot),
        };
      }

      const matches = countOccurrences(current.content, parsed.old_string);
      if (matches === 0) {
        throw new Error(`Target string not found in ${resolved.relativePath}.`);
      }
      if (matches > 1 && !replaceAll) {
        throw new Error(
          `Found multiple matches (${matches}) in ${resolved.relativePath}. Set replace_all to true or provide a more specific old_string.`,
        );
      }

      const updatedNormalized = replaceAll
        ? current.content.split(parsed.old_string).join(parsed.new_string)
        : current.content.replace(parsed.old_string, parsed.new_string);
      const writtenContent = restoreLineEndings(updatedNormalized, current.lineEnding);
      await writeTextAtomic(ctx, resolved.fullPath, writtenContent);
      const updatedSnapshot = await buildSnapshot(ctx, resolved.fullPath, updatedNormalized, false);

      return {
        content: `Updated ${resolved.relativePath}`,
        structured: {
          path: resolved.relativePath,
          operation: "update",
          replacements: replaceAll ? matches : 1,
          originalFile: current.content,
          structuredPatch: buildStructuredPatch(current.content, updatedNormalized),
        },
        statePatch: buildSnapshotPatch(ctx, updatedSnapshot),
      };
    },
  };
};

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
  writeTextAtomic,
} from "./shared";

const WRITE_TOOL_DESCRIPTION = `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- Prefer the Edit tool for modifying existing files - it only sends the diff. Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`;

export const createFileWriteTool = (): AgentTool => {
  const schema = z.object({
    file_path: z.string().min(1).describe("The absolute file path to write."),
    content: z.string(),
  });

  return {
    name: "Write",
    description: WRITE_TOOL_DESCRIPTION,
    schema,
    capabilities: ["requires-filesystem-write"],
    profile: createToolCapabilityProfile({
      riskLevel: "high",
      capabilityTags: ["filesystem_write"],
      sandboxExpectation: "workspace-write",
      auditCategory: "file_write",
    }),
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    invoke: async (input, ctx): Promise<ToolResult> => {
      const parsed = schema.parse(input);
      const resolved = await resolveWorkspacePath(ctx, parsed.file_path);

      const exists = await pathExists(ctx, resolved.fullPath);

      let originalFile: string | null = null;
      if (exists) {
        const snapshot = getTrackedSnapshot(ctx, resolved.fullPath);
        if (!snapshot || snapshot.partial) {
          throw new Error("Existing files must be fully read before they can be overwritten.");
        }
        const current = await readTextFileDetailed(ctx, resolved.fullPath, {
          maxReadBytes: Number.MAX_SAFE_INTEGER,
        });
        await assertFreshSnapshot(ctx, snapshot, resolved.fullPath, current.content);
        originalFile = current.content;
      }

      await writeTextAtomic(ctx, resolved.fullPath, parsed.content);
      const normalizedContent = parsed.content.replaceAll("\r\n", "\n");
      const newSnapshot = await buildSnapshot(ctx, resolved.fullPath, normalizedContent, false);

      return {
        content: `${exists ? "Updated" : "Created"} ${resolved.relativePath}`,
        structured: {
          type: exists ? "update" : "create",
          path: resolved.relativePath,
          content: normalizedContent,
          originalFile,
          structuredPatch: buildStructuredPatch(originalFile, normalizedContent),
        },
        statePatch: buildSnapshotPatch(ctx, newSnapshot),
      };
    },
  };
};

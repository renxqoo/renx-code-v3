import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import type { AgentTool, ToolContext, ToolResult } from "@renx/agent";
import { createToolCapabilityProfile } from "@renx/agent";
import { z } from "zod";

import { writeBinaryArtifact } from "../bash/tool-result-storage";
import {
  buildSnapshot,
  buildWorkspaceToolPatch,
  getRecentRead,
  hashContent,
  readTextFileDetailed,
  readTextFileRange,
  resolveWorkspacePath,
} from "./shared";

export interface CreateFileReadToolOptions {
  maxReadBytes?: number;
  binaryProbeBytes?: number;
}

const FILE_UNCHANGED_STUB =
  "File unchanged since last read. Reuse the earlier read result instead of reading it again.";
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const INLINE_BINARY_BYTES = 256_000;
const READ_TOOL_DESCRIPTION = `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to 2000 lines starting from the beginning of the file
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- Results are returned using cat -n format, with line numbers starting at 1
- This tool allows Claude Code to read images (eg PNG, JPG, etc).
- This tool can read PDF files (.pdf). For large PDFs, provide the pages parameter to read specific page ranges.
- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs.
- This tool can only read files, not directories.`;

const formatWithLineNumbers = (content: string, startLine: number): string =>
  content
    .split("\n")
    .map((line, index) => `${startLine + index}: ${line}`)
    .join("\n");

const buildNotebookText = (
  cells: Array<{ index: number; type: string; source: string; outputCount: number }>,
): string =>
  cells
    .map((cell) =>
      [
        `Cell ${cell.index} [${cell.type}]`,
        cell.source.length > 0 ? cell.source.trimEnd() : "(empty)",
      ].join("\n"),
    )
    .join("\n\n");

const getImageMediaType = (extension: string): string => {
  switch (extension) {
    case ".jpg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    default:
      return `image/${extension.slice(1)}`;
  }
};

const readBinaryPayload = async (
  ctx: ToolContext,
  fullPath: string,
  extension: string,
  type: "image" | "pdf",
): Promise<
  | { mode: "inline"; base64: string; mediaType: string; size: number }
  | { mode: "artifact"; artifactPath: string; mediaType: string; size: number }
> => {
  const payload =
    ctx.backend?.readBinaryFile && ctx.backend.capabilities().filesystemRead
      ? Buffer.from(await ctx.backend.readBinaryFile(fullPath))
      : await readFile(fullPath);
  const mediaType = type === "pdf" ? "application/pdf" : getImageMediaType(extension);
  if (payload.byteLength <= INLINE_BINARY_BYTES) {
    return {
      mode: "inline",
      base64: payload.toString("base64"),
      mediaType,
      size: payload.byteLength,
    };
  }
  const artifact = writeBinaryArtifact(payload, extension.slice(1), {
    filePrefix: type,
  });
  return {
    mode: "artifact",
    artifactPath: artifact.path,
    mediaType,
    size: payload.byteLength,
  };
};

export const createFileReadTool = (options?: CreateFileReadToolOptions): AgentTool => {
  const schema = z.object({
    file_path: z.string().min(1).describe("The absolute file path to read."),
    offset: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("1-based line offset to start reading from."),
    limit: z.number().int().positive().optional().describe("Maximum number of lines to read."),
    pages: z.string().optional().describe('Optional PDF page selection such as "1-5".'),
  });

  return {
    name: "Read",
    description: READ_TOOL_DESCRIPTION,
    schema,
    capabilities: ["requires-filesystem-read"],
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["filesystem_read", "search"],
      sandboxExpectation: "read-only",
      auditCategory: "file_read",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    invoke: async (input, ctx): Promise<ToolResult> => {
      const parsed = schema.parse(input);
      const resolved = await resolveWorkspacePath(ctx, parsed.file_path);
      const maxReadBytes = options?.maxReadBytes ?? 256_000;
      const binaryProbeBytes = options?.binaryProbeBytes;
      const extension = extname(resolved.fullPath).toLowerCase();
      const offset = parsed.offset ?? 1;
      const limit = parsed.limit;

      if (extension === ".ipynb") {
        const notebook = await readTextFileDetailed(ctx, resolved.fullPath, {
          maxReadBytes,
          ...(binaryProbeBytes !== undefined ? { binaryProbeBytes } : {}),
        });
        const parsedNotebook = JSON.parse(notebook.content) as {
          cells?: Array<{
            cell_type?: string;
            source?: string[] | string;
            outputs?: unknown[];
          }>;
        };
        const cells = (parsedNotebook.cells ?? []).map((cell, index) => ({
          index,
          type: cell.cell_type ?? "unknown",
          source: Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? ""),
          outputCount: Array.isArray(cell.outputs) ? cell.outputs.length : 0,
        }));
        const content = buildNotebookText(cells);
        const readHash = hashContent(notebook.content);
        const recentRead = getRecentRead(ctx, resolved.fullPath);
        if (
          recentRead?.type === "notebook" &&
          recentRead.offset === 1 &&
          recentRead.limit === undefined &&
          recentRead.mtimeMs === notebook.mtimeMs &&
          recentRead.size === notebook.size &&
          recentRead.sha256 === readHash
        ) {
          return {
            content: FILE_UNCHANGED_STUB,
            structured: {
              path: resolved.relativePath,
              type: "file_unchanged",
            },
          };
        }

        const snapshot = await buildSnapshot(ctx, resolved.fullPath, notebook.content, false);
        return {
          content,
          structured: {
            path: resolved.relativePath,
            type: "notebook",
            cells,
          },
          statePatch: buildWorkspaceToolPatch(ctx, (state) => ({
            ...state,
            fileSnapshots: {
              ...state.fileSnapshots,
              [snapshot.path]: snapshot,
            },
            recentReads: {
              ...state.recentReads,
              [snapshot.path]: {
                path: snapshot.path,
                type: "notebook",
                offset: 1,
                mtimeMs: notebook.mtimeMs,
                size: notebook.size,
                sha256: readHash,
              },
            },
          })),
        };
      }

      if (IMAGE_EXTENSIONS.has(extension)) {
        const binary = await readBinaryPayload(ctx, resolved.fullPath, extension, "image");
        return {
          content:
            binary.mode === "inline"
              ? `Image file ${resolved.relativePath} loaded for multimodal use (${binary.size} bytes).`
              : `Image file ${resolved.relativePath} stored at ${binary.artifactPath} for multimodal use (${binary.size} bytes).`,
          structured: {
            path: resolved.relativePath,
            type: "image",
            size: binary.size,
            mediaType: binary.mediaType,
            ...(binary.mode === "inline"
              ? { base64: binary.base64 }
              : { artifactPath: binary.artifactPath }),
          },
        };
      }

      if (extension === ".pdf") {
        const binary = await readBinaryPayload(ctx, resolved.fullPath, extension, "pdf");
        return {
          content:
            binary.mode === "inline"
              ? `PDF file ${resolved.relativePath} loaded (${binary.size} bytes).`
              : `PDF file ${resolved.relativePath} stored at ${binary.artifactPath} (${binary.size} bytes).`,
          structured: {
            path: resolved.relativePath,
            type: "pdf",
            size: binary.size,
            mediaType: binary.mediaType,
            ...(parsed.pages ? { pages: parsed.pages } : {}),
            ...(binary.mode === "inline"
              ? { base64: binary.base64 }
              : { artifactPath: binary.artifactPath }),
          },
        };
      }

      if (limit !== undefined || offset > 1) {
        const ranged = await readTextFileRange(ctx, resolved.fullPath, {
          offset,
          maxReadBytes,
          ...(binaryProbeBytes !== undefined ? { binaryProbeBytes } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        const readHash = hashContent(ranged.content);
        const recentRead = getRecentRead(ctx, resolved.fullPath);
        if (
          recentRead?.type === "text" &&
          recentRead.offset === offset &&
          recentRead.limit === limit &&
          recentRead.mtimeMs === ranged.mtimeMs &&
          recentRead.size === ranged.size &&
          recentRead.sha256 === readHash
        ) {
          return {
            content: FILE_UNCHANGED_STUB,
            structured: {
              path: resolved.relativePath,
              type: "file_unchanged",
            },
          };
        }

        return {
          content: formatWithLineNumbers(ranged.content, ranged.startLine),
          structured: {
            path: resolved.relativePath,
            type: "text",
            startLine: ranged.startLine,
            endLine: ranged.endLine,
            totalLines: ranged.totalLines,
            partial: ranged.partial,
          },
          statePatch: buildWorkspaceToolPatch(ctx, (state) => ({
            ...state,
            recentReads: {
              ...state.recentReads,
              [resolved.fullPath.replaceAll("\\", "/")]: {
                path: resolved.fullPath.replaceAll("\\", "/"),
                type: "text",
                offset,
                ...(limit !== undefined ? { limit } : {}),
                mtimeMs: ranged.mtimeMs,
                size: ranged.size,
                sha256: readHash,
              },
            },
          })),
        };
      }

      const file = await readTextFileDetailed(ctx, resolved.fullPath, {
        maxReadBytes,
        ...(binaryProbeBytes !== undefined ? { binaryProbeBytes } : {}),
      });
      const lines = file.content.split("\n");
      const totalLines = lines.length;
      const endLine = totalLines;
      const readHash = hashContent(file.content);
      const recentRead = getRecentRead(ctx, resolved.fullPath);
      if (
        recentRead?.type === "text" &&
        recentRead.offset === 1 &&
        recentRead.limit === undefined &&
        recentRead.mtimeMs === file.mtimeMs &&
        recentRead.size === file.size &&
        recentRead.sha256 === readHash
      ) {
        return {
          content: FILE_UNCHANGED_STUB,
          structured: {
            path: resolved.relativePath,
            type: "file_unchanged",
          },
        };
      }

      const snapshot = await buildSnapshot(ctx, resolved.fullPath, file.content, false);
      return {
        content: formatWithLineNumbers(file.content, 1),
        structured: {
          path: resolved.relativePath,
          type: "text",
          startLine: 1,
          endLine,
          totalLines,
          partial: false,
        },
        statePatch: buildWorkspaceToolPatch(ctx, (state) => ({
          ...state,
          fileSnapshots: {
            ...state.fileSnapshots,
            [snapshot.path]: snapshot,
          },
          recentReads: {
            ...state.recentReads,
            [snapshot.path]: {
              path: snapshot.path,
              type: "text",
              offset: 1,
              mtimeMs: file.mtimeMs,
              size: file.size,
              sha256: readHash,
            },
          },
        })),
      };
    },
  };
};

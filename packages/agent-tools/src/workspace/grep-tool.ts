import type { AgentTool, ToolResult } from "@renx/agent";
import { createToolCapabilityProfile } from "@renx/agent";
import { z } from "zod";

import {
  applyPagination,
  collectWorkspaceFiles,
  globToRegExp,
  readTextFile,
  renderPaginationNote,
  resolveWorkspacePath,
  toWorkspaceRelativePath,
} from "./shared";

export interface CreateGrepToolOptions {
  defaultHeadLimit?: number;
  maxReadBytesPerFile?: number;
}

const GREP_TOOL_DESCRIPTION = `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use Grep for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
  - Use Agent for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep)
  - Multiline matching: For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\``;

const grepOutputModeSchema = z.enum(["content", "files_with_matches", "count"]);

const buildRegex = (
  pattern: string,
  options: {
    caseInsensitive: boolean | undefined;
    multiline: boolean | undefined;
    global?: boolean | undefined;
  },
): RegExp => {
  const flags = [
    options.caseInsensitive ? "i" : "",
    options.multiline ? "ms" : "m",
    options.global ? "g" : "",
  ].join("");
  return new RegExp(pattern, flags);
};

export const createGrepTool = (options?: CreateGrepToolOptions): AgentTool => {
  const schema = z.object({
    pattern: z.string().min(1),
    path: z.string().optional(),
    glob: z.string().optional(),
    type: z.string().optional(),
    output_mode: grepOutputModeSchema.optional(),
    head_limit: z.number().int().min(0).optional(),
    offset: z.number().int().min(0).optional(),
    "-i": z.boolean().optional(),
    multiline: z.boolean().optional(),
    "-n": z.boolean().optional(),
    "-A": z.number().int().min(0).optional(),
    "-B": z.number().int().min(0).optional(),
    "-C": z.number().int().min(0).optional(),
  });

  return {
    name: "Grep",
    description: GREP_TOOL_DESCRIPTION,
    schema,
    capabilities: ["requires-filesystem-read"],
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["filesystem_read", "search"],
      sandboxExpectation: "read-only",
      auditCategory: "search",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    invoke: async (input, ctx): Promise<ToolResult> => {
      const parsed = schema.parse(input);
      const searchRoot = await resolveWorkspacePath(ctx, parsed.path ?? ".");
      const files = await collectWorkspaceFiles(ctx, searchRoot.workspaceRoot, searchRoot.fullPath);
      const normalizedGlob = parsed.type ? `**/*.${parsed.type.replace(/^\./, "")}` : parsed.glob;
      const fileFilter = normalizedGlob ? globToRegExp(normalizedGlob) : undefined;
      const outputMode = parsed.output_mode ?? "files_with_matches";
      const showLineNumbers = parsed["-n"] ?? true;
      const contextWindow = parsed["-C"] ?? Math.max(parsed["-A"] ?? 0, parsed["-B"] ?? 0);
      const filteredFiles = files.filter((file) => {
        if (!fileFilter) return true;
        return fileFilter.test(toWorkspaceRelativePath(searchRoot.fullPath, file.fullPath));
      });

      if (outputMode === "files_with_matches") {
        const regex = buildRegex(parsed.pattern, {
          caseInsensitive: parsed["-i"],
          multiline: parsed.multiline,
        });
        const matches: string[] = [];
        for (const file of filteredFiles) {
          const text = await readTextFile(ctx, file.fullPath, {
            maxReadBytes: options?.maxReadBytesPerFile ?? 512_000,
          });
          regex.lastIndex = 0;
          if (regex.test(text.content)) {
            matches.push(toWorkspaceRelativePath(searchRoot.workspaceRoot, file.fullPath));
          }
        }
        const pagination = applyPagination(matches, parsed.offset ?? 0, parsed.head_limit);
        return {
          content:
            (pagination.items.length === 0
              ? "No files found"
              : `Found ${pagination.items.length} file(s)\n${pagination.items.join("\n")}`) +
            renderPaginationNote(pagination.appliedLimit, pagination.appliedOffset),
          structured: {
            mode: outputMode,
            files: pagination.items,
            total: matches.length,
          },
        };
      }

      if (outputMode === "count") {
        const lines: string[] = [];
        let totalMatches = 0;
        let totalFiles = 0;

        for (const file of filteredFiles) {
          const text = await readTextFile(ctx, file.fullPath, {
            maxReadBytes: options?.maxReadBytesPerFile ?? 512_000,
          });
          const regex = buildRegex(parsed.pattern, {
            caseInsensitive: parsed["-i"],
            multiline: parsed.multiline,
            global: true,
          });
          const matches = [...text.content.matchAll(regex)];
          if (matches.length === 0) continue;
          lines.push(
            `${toWorkspaceRelativePath(searchRoot.workspaceRoot, file.fullPath)}:${matches.length}`,
          );
          totalMatches += matches.length;
          totalFiles += 1;
        }

        const pagination = applyPagination(lines, parsed.offset ?? 0, parsed.head_limit);
        return {
          content:
            (pagination.items.length === 0
              ? "No matches found"
              : `${pagination.items.join("\n")}\n\nFound ${totalMatches} total occurrences across ${totalFiles} files.`) +
            renderPaginationNote(pagination.appliedLimit, pagination.appliedOffset),
          structured: {
            mode: outputMode,
            totalMatches,
            totalFiles,
          },
        };
      }

      const lines: string[] = [];
      for (const file of filteredFiles) {
        const text = await readTextFile(ctx, file.fullPath, {
          maxReadBytes: options?.maxReadBytesPerFile ?? 512_000,
        });
        const relativePath = toWorkspaceRelativePath(searchRoot.workspaceRoot, file.fullPath);
        const allLines = text.content.split("\n");
        const regex = buildRegex(parsed.pattern, {
          caseInsensitive: parsed["-i"],
          multiline: false,
        });
        const selected = new Set<number>();

        for (const [index, line] of allLines.entries()) {
          regex.lastIndex = 0;
          if (!regex.test(line)) continue;
          const start = Math.max(0, index - contextWindow);
          const end = Math.min(allLines.length - 1, index + contextWindow);
          for (let cursor = start; cursor <= end; cursor += 1) {
            selected.add(cursor);
          }
        }

        for (const lineIndex of [...selected].sort((left, right) => left - right)) {
          const prefix = showLineNumbers ? `${relativePath}:${lineIndex + 1}:` : `${relativePath}:`;
          lines.push(`${prefix}${allLines[lineIndex] ?? ""}`);
        }
      }

      const contentHeadLimit = parsed.head_limit ?? options?.defaultHeadLimit;
      const pagination = applyPagination(lines, parsed.offset ?? 0, contentHeadLimit);
      return {
        content:
          (pagination.items.length === 0 ? "No matches found" : pagination.items.join("\n")) +
          renderPaginationNote(pagination.appliedLimit, pagination.appliedOffset),
        structured: {
          mode: outputMode,
          lines: pagination.items,
          total: lines.length,
        },
      };
    },
  };
};

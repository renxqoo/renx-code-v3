/**
 * Memory directory scanner.
 *
 * 1:1 replicate of claude-code-source/src/memdir/memoryScan.ts + readFileInRange.ts.
 *
 * Scans a memory directory for .md files, reads their frontmatter headers,
 * and returns a sorted list.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { parseFrontmatter } from "./frontmatter";
import type { MemoryTaxonomyType } from "../types";

export type MemoryFileHeader = {
  filename: string;
  filePath: string;
  mtimeMs: number;
  description: string | null;
  type: MemoryTaxonomyType | undefined;
};

const MAX_MEMORY_FILES = 200;
const FRONTMATTER_MAX_LINES = 30;

const VALID_MEMORY_TYPES: ReadonlySet<string> = new Set([
  "user",
  "feedback",
  "project",
  "reference",
]);

/**
 * Scan a memory directory for .md files, read their frontmatter, and return
 * a header list sorted newest-first (capped at maxFiles).
 *
 * 1:1 replicate of scanMemoryFiles() from claude-code-source.
 */
export async function scanMemoryFiles(
  memoryDir: string,
  options?: { maxFiles?: number; signal?: AbortSignal },
): Promise<MemoryFileHeader[]> {
  const maxFiles = options?.maxFiles ?? MAX_MEMORY_FILES;

  try {
    const entries = await readdir(memoryDir, { recursive: true });
    const mdFiles = entries.filter(
      (f): f is string => typeof f === "string" && f.endsWith(".md") && basename(f) !== "MEMORY.md",
    );

    const headerResults = await Promise.allSettled(
      mdFiles.map(async (relativePath): Promise<MemoryFileHeader> => {
        const filePath = join(memoryDir, relativePath);
        const raw = await readFile(filePath, "utf8");

        // Strip BOM + normalize CRLF
        const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n/g, "\n");

        // Only read first N lines for frontmatter
        const lines = text.split("\n").slice(0, FRONTMATTER_MAX_LINES);
        const headerContent = lines.join("\n");

        const { frontmatter } = parseFrontmatter(headerContent, filePath);

        // Get mtime from stat
        const stats = await stat(filePath);

        const typeValue = frontmatter.type;
        const type: MemoryTaxonomyType | undefined =
          typeof typeValue === "string" && VALID_MEMORY_TYPES.has(typeValue)
            ? (typeValue as MemoryTaxonomyType)
            : undefined;

        return {
          filename: relativePath,
          filePath,
          mtimeMs: stats.mtimeMs,
          description:
            typeof frontmatter.description === "string" && frontmatter.description.length > 0
              ? frontmatter.description
              : null,
          type,
        };
      }),
    );

    return headerResults
      .filter((r): r is PromiseFulfilledResult<MemoryFileHeader> => r.status === "fulfilled")
      .map((r) => r.value)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, maxFiles);
  } catch {
    return [];
  }
}

/**
 * Read a range of lines from a file.
 *
 * 1:1 replicate of readFileInRange() from claude-code-source (simplified fast path).
 * For memory files (< 10MB), reads the whole file and selects lines in memory.
 */
export async function readFileInRange(
  filePath: string,
  offset = 0,
  maxLines?: number,
): Promise<{
  content: string;
  lineCount: number;
  totalLines: number;
  readBytes: number;
  mtimeMs: number;
}> {
  const raw = await readFile(filePath, "utf8");
  const stats = await stat(filePath);

  // Strip BOM + normalize CRLF
  const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n/g, "\n");

  const endLine = maxLines !== undefined ? offset + maxLines : Infinity;

  const selectedLines: string[] = [];
  let lineIndex = 0;
  let startPos = 0;
  let newlinePos: number;

  while ((newlinePos = text.indexOf("\n", startPos)) !== -1) {
    if (lineIndex >= offset && lineIndex < endLine) {
      let line = text.slice(startPos, newlinePos);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      selectedLines.push(line);
    }
    lineIndex++;
    startPos = newlinePos + 1;
  }

  // Final fragment (no trailing newline)
  if (startPos < text.length) {
    if (lineIndex >= offset && lineIndex < endLine) {
      let line = text.slice(startPos);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      selectedLines.push(line);
    }
    lineIndex++;
  }

  const content = selectedLines.join("\n");
  return {
    content,
    lineCount: selectedLines.length,
    totalLines: lineIndex,
    readBytes: Buffer.byteLength(content, "utf8"),
    mtimeMs: stats.mtimeMs,
  };
}

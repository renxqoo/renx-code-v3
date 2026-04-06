/**
 * File-based memory directory store.
 *
 * Reads/writes memory entries as individual .md files with YAML frontmatter,
 * matching claude-code-source's `~/.claude/projects/<slug>/memory/` layout.
 *
 * Each semantic entry is stored as one .md file in the base directory.
 * The store reads all .md files on load and writes them back on save.
 * MEMORY.md is skipped during load (it's an index, not a memory file).
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type {
  MemoryScope,
  MemorySemanticEntry,
  MemorySnapshot,
  MemoryTaxonomyType,
  ScopedMemoryStore,
} from "../types";
import { createMemorySnapshot } from "../snapshot";
import { parseFrontmatter } from "./frontmatter";

/**
 * Ensure a memory directory exists. Idempotent — recursive mkdir.
 *
 * 1:1 replicate of ensureMemoryDirExists() from claude-code-source.
 */
export async function ensureMemoryDirExists(memoryDir: string): Promise<void> {
  await mkdir(memoryDir, { recursive: true });
}

/**
 * Format a MemorySemanticEntry as a markdown file with YAML frontmatter.
 *
 * 1:1 replicate of the memory file format from claude-code-source.
 */
function entryToMarkdown(entry: MemorySemanticEntry): string {
  const lines: string[] = ["---"];
  if (entry.title) lines.push(`name: ${entry.title}`);
  if (entry.description) lines.push(`description: ${entry.description}`);
  if (entry.type) lines.push(`type: ${entry.type}`);
  if (entry.tags && entry.tags.length > 0) {
    lines.push("tags:");
    for (const tag of entry.tags) {
      lines.push(`  - ${tag}`);
    }
  }
  if (entry.updatedAt) lines.push(`updatedAt: ${entry.updatedAt}`);
  lines.push("---");
  lines.push("");

  let body = entry.content || "";
  if (entry.why) {
    body += `\n\n**Why:** ${entry.why}`;
  }
  if (entry.howToApply) {
    body += `\n\n**How to apply:** ${entry.howToApply}`;
  }

  lines.push(body.trim());
  return lines.join("\n");
}

/**
 * Sanitize a memory entry title into a safe filename.
 */
function titleToFilename(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "untitled"
  );
}

/**
 * File-based memory directory store.
 *
 * Each semantic entry is stored as a .md file in the base directory.
 * The store reads all .md files on load and writes them back on save.
 *
 * Scope/namespace parameters are used for ScopedMemoryStore interface
 * compatibility — the store resolves them to a subdirectory under baseDir.
 * When scope/namespace aren't meaningful, the baseDir is used directly.
 */
export class FileMemoryDirStore implements ScopedMemoryStore {
  constructor(private readonly baseDir: string) {}

  async load(_scope: MemoryScope, _namespace: string): Promise<MemorySnapshot | null> {
    try {
      const files = await readdir(this.baseDir);
      const mdFiles = files.filter(
        (f): f is string =>
          typeof f === "string" && f.endsWith(".md") && basename(f) !== "MEMORY.md",
      );

      if (mdFiles.length === 0) return null;

      const parsed = await Promise.allSettled(
        mdFiles.map(async (filename): Promise<MemorySemanticEntry> => {
          const filePath = join(this.baseDir, filename);
          const raw = await readFile(filePath, "utf8");

          // Strip BOM + normalize CRLF
          const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n/g, "\n");

          const { frontmatter, content } = parseFrontmatter(text, filePath);

          // Get mtime from stat for updatedAt fallback
          const stats = await stat(filePath);

          const entry: MemorySemanticEntry = {
            id: `memdir:${filename}`,
            title:
              typeof frontmatter.name === "string"
                ? frontmatter.name
                : filename.replace(/\.md$/, ""),
            content: content.trim(),
            why: extractBodyField(content, "Why"),
            howToApply: extractBodyField(content, "How to apply"),
            tags: Array.isArray(frontmatter.tags)
              ? frontmatter.tags.map(String)
              : typeof frontmatter.tags === "string"
                ? [frontmatter.tags]
                : undefined,
            updatedAt:
              typeof frontmatter.updatedAt === "string"
                ? frontmatter.updatedAt
                : new Date(stats.mtimeMs).toISOString(),
          };

          // Optional fields — only set when present (exactOptionalPropertyTypes)
          if (typeof frontmatter.description === "string") {
            entry.description = frontmatter.description;
          }
          if (typeof frontmatter.type === "string") {
            entry.type = frontmatter.type as MemoryTaxonomyType;
          }

          return entry;
        }),
      );

      const entries = parsed
        .filter((r): r is PromiseFulfilledResult<MemorySemanticEntry> => r.status === "fulfilled")
        .map((r) => r.value);

      if (entries.length === 0) return null;

      return createMemorySnapshot({
        semantic: { entries },
      });
    } catch {
      return null;
    }
  }

  async save(_scope: MemoryScope, _namespace: string, snapshot: MemorySnapshot): Promise<void> {
    await ensureMemoryDirExists(this.baseDir);

    const normalized = createMemorySnapshot(snapshot);
    const entries = normalized.semantic.entries;

    // Write each entry as a .md file
    for (const entry of entries) {
      const filename = titleToFilename(entry.title || entry.id) + ".md";
      const filePath = join(this.baseDir, filename);
      const markdown = entryToMarkdown(entry);
      await writeFile(filePath, markdown, "utf8");
    }
  }
}

/**
 * Extract a body field like "**Why:** ..." or "**How to apply:** ..." from content.
 */
function extractBodyField(content: string, fieldName: string): string | undefined {
  // Match both "**Why:** ..." and "Why: ..." formats
  const pattern = new RegExp(`(?:\\*\\*)?${fieldName}:?(?:\\*\\*)?\\s+(.+?)(?:\\n\\n|$)`, "s");
  const match = content.match(pattern);
  return match?.[1]?.trim();
}

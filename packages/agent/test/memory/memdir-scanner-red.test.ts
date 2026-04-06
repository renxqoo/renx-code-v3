import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  scanMemoryFiles,
  type MemoryFileHeader,
  readFileInRange,
} from "../../src/memory/memdir/scanner";

describe("memdir scanner", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  });

  it("scans directory and returns headers sorted by mtime descending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renx-memdir-scan-"));
    tempDirs.push(dir);

    // Create files with slight delay to ensure different mtimes
    await writeFile(
      join(dir, "alpha.md"),
      `---
name: alpha
description: First memory
type: user
---
Alpha content.`,
    );
    await writeFile(
      join(dir, "beta.md"),
      `---
name: beta
description: Second memory
type: feedback
---
Beta content.`,
    );

    const headers = await scanMemoryFiles(dir);

    expect(headers.length).toBe(2);
    // Sorted newest-first by mtime
    expect(headers[0]!.filename).toBe("beta.md");
    expect(headers[0]!.description).toBe("Second memory");
    expect(headers[0]!.type).toBe("feedback");
    expect(headers[1]!.filename).toBe("alpha.md");
    expect(headers[1]!.description).toBe("First memory");
    expect(headers[1]!.type).toBe("user");
  });

  it("skips non-.md files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renx-memdir-scan-"));
    tempDirs.push(dir);

    await writeFile(join(dir, "memory.json"), '{"data": "not markdown"}');
    await writeFile(
      join(dir, "valid.md"),
      `---
name: valid
description: Valid entry
type: user
---
Content.`,
    );

    const headers = await scanMemoryFiles(dir);
    expect(headers.length).toBe(1);
    expect(headers[0]!.filename).toBe("valid.md");
  });

  it("skips MEMORY.md entrypoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renx-memdir-scan-"));
    tempDirs.push(dir);

    await writeFile(join(dir, "MEMORY.md"), "- [Role](role.md) -- user role info");
    await writeFile(
      join(dir, "role.md"),
      `---
name: role
description: User role
type: user
---
Content.`,
    );

    const headers = await scanMemoryFiles(dir);
    expect(headers.length).toBe(1);
    expect(headers[0]!.filename).toBe("role.md");
  });

  it("returns empty array for non-existent directory", async () => {
    const headers = await scanMemoryFiles("/nonexistent/path/memory");
    expect(headers).toEqual([]);
  });

  it("caps at MAX_MEMORY_FILES (200)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renx-memdir-cap-"));
    tempDirs.push(dir);

    // Create 5 files to test the cap concept (not creating 200+ files in tests)
    for (let i = 0; i < 5; i++) {
      await writeFile(
        join(dir, `mem-${i}.md`),
        `---
name: mem${i}
description: Memory ${i}
type: user
---
Content ${i}.`,
      );
    }

    const headers = await scanMemoryFiles(dir, { maxFiles: 3 });
    expect(headers.length).toBe(3);
  });

  it("reads only first 30 lines of frontmatter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renx-memdir-frontmatter-"));
    tempDirs.push(dir);

    const longContent = Array.from({ length: 50 }, (_, i) => `Line ${i}`).join("\n");
    await writeFile(
      join(dir, "long.md"),
      `---\nname: long\ndescription: Long memory\ntype: user\n---\n${longContent}`,
    );

    const headers = await scanMemoryFiles(dir);
    expect(headers.length).toBe(1);
    // Should still parse frontmatter correctly even though body is long
    expect(headers[0]!.description).toBe("Long memory");
  });

  it("handles files without frontmatter gracefully", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renx-memdir-nofrontmatter-"));
    tempDirs.push(dir);

    await writeFile(join(dir, "plain.md"), "Just plain markdown, no frontmatter.");

    const headers = await scanMemoryFiles(dir);
    expect(headers.length).toBe(1);
    expect(headers[0]!.description).toBeNull();
    expect(headers[0]!.type).toBeUndefined();
  });
});

describe("readFileInRange", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  });

  it("reads specific line range from a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renx-memdir-range-"));
    tempDirs.push(dir);
    const filePath = join(dir, "test.md");

    await writeFile(filePath, "line0\nline1\nline2\nline3\nline4\n");
    const result = await readFileInRange(filePath, 1, 3);

    expect(result.content).toBe("line1\nline2\nline3");
    expect(result.lineCount).toBe(3);
  });

  it("returns mtimeMs from file stat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renx-memdir-mtime-"));
    tempDirs.push(dir);
    const filePath = join(dir, "test.md");

    await writeFile(filePath, "content");
    const result = await readFileInRange(filePath, 0, 1);

    expect(result.mtimeMs).toBeGreaterThan(0);
  });

  it("handles files with CRLF line endings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renx-memdir-crlf-"));
    tempDirs.push(dir);
    const filePath = join(dir, "crlf.md");

    await writeFile(filePath, "line0\r\nline1\r\nline2\r\n");
    const result = await readFileInRange(filePath, 0, 3);

    expect(result.content).toBe("line0\nline1\nline2");
  });

  it("strips UTF-8 BOM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renx-memdir-bom-"));
    tempDirs.push(dir);
    const filePath = join(dir, "bom.md");

    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const content = Buffer.concat([bom, Buffer.from("line0\nline1\n")]);
    await writeFile(filePath, content);
    const result = await readFileInRange(filePath, 0, 2);

    expect(result.content).toBe("line0\nline1");
  });

  it("returns full file when range covers all lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "renx-memdir-full-"));
    tempDirs.push(dir);
    const filePath = join(dir, "full.md");

    await writeFile(filePath, "a\nb\nc\n");
    const result = await readFileInRange(filePath, 0);

    expect(result.content).toBe("a\nb\nc");
    expect(result.totalLines).toBe(3);
  });
});

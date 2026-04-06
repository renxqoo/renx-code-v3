import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import type { AgentRunContext, ExecutionBackend, ToolContext, ToolResult } from "@renx/agent";
import { LocalBackend, applyStatePatch } from "@renx/agent";
import type { ToolCall } from "@renx/model";

import {
  createCodingToolset,
  createFileEditTool,
  createFileReadTool,
  createFileWriteTool,
  createGlobTool,
  createGrepTool,
} from "../src/index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createToolContext(
  workspaceRoot: string,
  backend: ToolContext["backend"] = new LocalBackend(),
): ToolContext {
  const runContext: AgentRunContext = {
    input: {
      messages: [
        {
          id: "msg_tool_1",
          messageId: "msg_tool_1",
          role: "user",
          content: "test",
          createdAt: new Date().toISOString(),
          source: "input",
        },
      ],
    },
    identity: { userId: "u1", tenantId: "t1", roles: [] },
    state: {
      runId: "run_1",
      messages: [],
      scratchpad: {},
      memory: {},
      stepCount: 0,
      status: "running",
    },
    services: {},
    metadata: { workspaceRoot },
  };
  const toolCall: ToolCall = { id: "tc_1", name: "tool", input: {} };
  return { runContext, toolCall, backend };
}

function applyToolState(ctx: ToolContext, result: ToolResult): void {
  ctx.runContext.state = applyStatePatch(ctx.runContext.state, result.statePatch);
}

function createVirtualFilesystemBackend(
  workspaceRoot: string,
  files: Record<string, string>,
): ExecutionBackend {
  const store = new Map<string, string>(Object.entries(files));

  const listFiles = async (path: string) => {
    const normalizedPath = path.replaceAll("\\", "/");
    const prefix = normalizedPath.endsWith("/") ? normalizedPath : `${normalizedPath}/`;
    const children = new Map<
      string,
      {
        path: string;
        isDirectory: boolean;
        size?: number;
        modifiedAt: string;
      }
    >();

    for (const [fullPath, content] of store.entries()) {
      if (!fullPath.startsWith(prefix)) continue;
      const remainder = fullPath.slice(prefix.length);
      if (remainder.length === 0) continue;
      const [nextSegment, ...rest] = remainder.split("/");
      const childPath = `${normalizedPath}/${nextSegment}`;
      if (rest.length === 0) {
        children.set(childPath, {
          path: childPath,
          isDirectory: false,
          size: Buffer.byteLength(content, "utf8"),
          modifiedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        });
        continue;
      }
      children.set(childPath, {
        path: childPath,
        isDirectory: true,
        modifiedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      });
    }

    if (normalizedPath.replaceAll("\\", "/") === workspaceRoot.replaceAll("\\", "/")) {
      return [...children.values()];
    }

    if (children.size === 0 && ![...store.keys()].some((key) => key === normalizedPath)) {
      throw new Error(`Path not found: ${path}`);
    }
    return [...children.values()];
  };

  return {
    kind: "virtual",
    capabilities: () => ({
      exec: false,
      filesystemRead: true,
      filesystemWrite: true,
      network: false,
    }),
    readFile: async (path: string) => {
      const content = store.get(path.replaceAll("\\", "/"));
      if (content === undefined) {
        throw new Error(`File not found: ${path}`);
      }
      return content;
    },
    writeFile: async (path: string, content: string) => {
      store.set(path.replaceAll("\\", "/"), content);
    },
    listFiles,
  };
}

describe("workspace file tools", () => {
  it("reads text files by range, blocks binary files, and blocks workspace escapes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-read-"));
    tempDirs.push(dir);
    const srcDir = join(dir, "src");
    await mkdir(srcDir, { recursive: true });

    const filePath = join(srcDir, "app.ts");
    const outsidePath = join(dirname(dir), "outside.ts");
    const binaryPath = join(srcDir, "image.bin");

    await writeFile(filePath, "line one\nline two\nline three\n", "utf8");
    await writeFile(outsidePath, "export const outside = true;\n", "utf8");
    await writeFile(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0x03]));

    const ctx = createToolContext(dir);
    const tool = createFileReadTool();

    const rangeResult = await tool.invoke({ file_path: "src/app.ts", offset: 2, limit: 2 }, ctx);
    expect(rangeResult.content).toContain("2: line two");
    expect(rangeResult.content).toContain("3: line three");

    await expect(tool.invoke({ file_path: outsidePath }, ctx)).rejects.toThrow(
      /outside the workspace/i,
    );
    await expect(tool.invoke({ file_path: binaryPath }, ctx)).rejects.toThrow(/binary/i);
  });

  it("supports targeted reads for oversized files and deduplicates unchanged rereads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-read-large-"));
    tempDirs.push(dir);

    const filePath = join(dir, "logs", "app.log");
    await mkdir(dirname(filePath), { recursive: true });
    const content = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join("\n");
    await writeFile(filePath, `${content}\n`, "utf8");

    const ctx = createToolContext(dir);
    const tool = createFileReadTool({ maxReadBytes: 64 });

    const partial = await tool.invoke({ file_path: "logs/app.log", offset: 50, limit: 3 }, ctx);
    applyToolState(ctx, partial);

    expect(partial.content).toContain("50: line 50");
    expect(partial.content).toContain("52: line 52");
    expect(partial.structured).toMatchObject({
      path: "logs/app.log",
      startLine: 50,
      endLine: 52,
      partial: true,
      type: "text",
    });

    const deduped = await tool.invoke({ file_path: "logs/app.log", offset: 50, limit: 3 }, ctx);
    expect(deduped.content).toMatch(/unchanged since last read/i);
    expect(deduped.structured).toMatchObject({
      path: "logs/app.log",
      type: "file_unchanged",
    });
  });

  it("reads images and pdfs with multimodal-friendly structured payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-read-binary-"));
    tempDirs.push(dir);

    const imagePath = join(dir, "assets", "logo.png");
    const pdfPath = join(dir, "docs", "spec.pdf");
    await mkdir(dirname(imagePath), { recursive: true });
    await mkdir(dirname(pdfPath), { recursive: true });
    await writeFile(
      imagePath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04]),
    );
    await writeFile(
      pdfPath,
      Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF", "utf8"),
    );

    const ctx = createToolContext(dir);
    const tool = createFileReadTool();

    const imageResult = await tool.invoke({ file_path: "assets/logo.png" }, ctx);
    expect(imageResult.structured).toMatchObject({
      path: "assets/logo.png",
      type: "image",
      mediaType: "image/png",
    });
    expect(imageResult.structured).toHaveProperty("base64");

    const pdfResult = await tool.invoke({ file_path: "docs/spec.pdf" }, ctx);
    expect(pdfResult.structured).toMatchObject({
      path: "docs/spec.pdf",
      type: "pdf",
      mediaType: "application/pdf",
    });
    expect(pdfResult.structured).toHaveProperty("base64");
  });

  it("requires a prior read before editing, rejects ambiguous edits, and detects stale files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-edit-"));
    tempDirs.push(dir);
    const filePath = join(dir, "src", "feature.ts");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, "const value = 1;\nconst value = 1;\n", "utf8");

    const ctx = createToolContext(dir);
    const readTool = createFileReadTool();
    const editTool = createFileEditTool();

    await expect(
      editTool.invoke(
        { file_path: "src/feature.ts", old_string: "value = 1", new_string: "value = 2" },
        ctx,
      ),
    ).rejects.toThrow(/read/i);

    const readResult = await readTool.invoke({ file_path: "src/feature.ts" }, ctx);
    applyToolState(ctx, readResult);

    await expect(
      editTool.invoke(
        { file_path: "src/feature.ts", old_string: "value = 1", new_string: "value = 2" },
        ctx,
      ),
    ).rejects.toThrow(/multiple/i);

    await writeFile(filePath, "const value = 3;\nconst value = 3;\n", "utf8");

    await expect(
      editTool.invoke(
        {
          file_path: "src/feature.ts",
          old_string: "value = 3",
          new_string: "value = 4",
          replace_all: true,
        },
        ctx,
      ),
    ).rejects.toThrow(/modified since read/i);
  });

  it("reads notebooks, rejects notebook edits through Edit, and preserves CRLF when editing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-notebook-"));
    tempDirs.push(dir);

    const notebookPath = join(dir, "demo.ipynb");
    const scriptPath = join(dir, "src", "windows.ts");
    await mkdir(dirname(scriptPath), { recursive: true });
    await writeFile(
      notebookPath,
      JSON.stringify(
        {
          cells: [
            {
              cell_type: "code",
              metadata: {},
              source: ["print('hello')\n"],
              outputs: [],
              execution_count: null,
            },
          ],
          metadata: {},
          nbformat: 4,
          nbformat_minor: 5,
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      scriptPath,
      "const greeting = 'hello';\r\nconst target = 'windows';\r\n",
      "utf8",
    );

    const ctx = createToolContext(dir);
    const readTool = createFileReadTool();
    const editTool = createFileEditTool();

    const notebookRead = await readTool.invoke({ file_path: "demo.ipynb" }, ctx);
    applyToolState(ctx, notebookRead);
    expect(notebookRead.content).toContain("Cell 0 [code]");
    expect(notebookRead.structured).toMatchObject({
      path: "demo.ipynb",
      type: "notebook",
    });

    await expect(
      editTool.invoke({ file_path: "demo.ipynb", old_string: "hello", new_string: "world" }, ctx),
    ).rejects.toThrow(/NotebookEdit/i);

    const scriptRead = await readTool.invoke({ file_path: "src/windows.ts" }, ctx);
    applyToolState(ctx, scriptRead);

    const editResult = await editTool.invoke(
      { file_path: "src/windows.ts", old_string: "hello", new_string: "world" },
      ctx,
    );
    applyToolState(ctx, editResult);

    const rawScript = await readFile(scriptPath, "utf8");
    expect(rawScript).toContain("\r\n");
    expect(editResult.structured).toMatchObject({
      path: "src/windows.ts",
      operation: "update",
      originalFile: "const greeting = 'hello';\nconst target = 'windows';\n",
    });
    expect(editResult.structured).toHaveProperty("structuredPatch");
  });

  it("creates nested files atomically, and refuses to overwrite existing files that were not read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-write-"));
    tempDirs.push(dir);
    const filePath = join(dir, "src", "nested", "created.ts");
    const existingPath = join(dir, "src", "existing.ts");
    await mkdir(dirname(existingPath), { recursive: true });
    await writeFile(existingPath, "export const oldValue = 1;\n", "utf8");

    const ctx = createToolContext(dir);
    const writeTool = createFileWriteTool();

    const createResult = await writeTool.invoke(
      { file_path: "src/nested/created.ts", content: "export const created = true;\n" },
      ctx,
    );
    applyToolState(ctx, createResult);

    expect(await readFile(filePath, "utf8")).toContain("created = true");
    expect((await stat(filePath)).isFile()).toBe(true);

    await expect(
      writeTool.invoke(
        { file_path: "src/existing.ts", content: "export const oldValue = 2;\n" },
        ctx,
      ),
    ).rejects.toThrow(/read/i);
  });

  it("returns structured create and update details for Write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-write-structured-"));
    tempDirs.push(dir);
    const filePath = join(dir, "src", "feature.ts");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, "export const version = 1;\n", "utf8");

    const ctx = createToolContext(dir);
    const readTool = createFileReadTool();
    const writeTool = createFileWriteTool();

    const readResult = await readTool.invoke({ file_path: "src/feature.ts" }, ctx);
    applyToolState(ctx, readResult);

    const updateResult = await writeTool.invoke(
      { file_path: "src/feature.ts", content: "export const version = 2;\n" },
      ctx,
    );
    applyToolState(ctx, updateResult);

    expect(updateResult.structured).toMatchObject({
      type: "update",
      path: "src/feature.ts",
      originalFile: "export const version = 1;\n",
    });
    expect(updateResult.structured).toHaveProperty("structuredPatch");

    const createResult = await writeTool.invoke(
      { file_path: "src/new-file.ts", content: "export const created = true;\n" },
      ctx,
    );
    expect(createResult.structured).toMatchObject({
      type: "create",
      path: "src/new-file.ts",
      originalFile: null,
    });
  });

  it("honors backend filesystem primitives for text reads, writes, globbing, and grep", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-backend-fs-"));
    tempDirs.push(dir);
    const workspaceRoot = dir.replaceAll("\\", "/");
    const appPath = `${workspaceRoot}/src/app.ts`;
    const utilPath = `${workspaceRoot}/src/util.ts`;
    const backend = createVirtualFilesystemBackend(workspaceRoot, {
      [appPath]: "export const message = 'virtual backend';\n",
      [utilPath]: "export const helper = 'virtual grep target';\n",
    });
    const ctx = createToolContext(dir, backend);

    const readResult = await createFileReadTool().invoke({ file_path: "src/app.ts" }, ctx);
    applyToolState(ctx, readResult);
    expect(readResult.content).toContain("virtual backend");

    const writeResult = await createFileWriteTool().invoke(
      { file_path: "src/app.ts", content: "export const message = 'updated through backend';\n" },
      ctx,
    );
    applyToolState(ctx, writeResult);
    expect(writeResult.structured).toMatchObject({
      type: "update",
      path: "src/app.ts",
    });

    const globResult = await createGlobTool().invoke({ pattern: "**/*.ts" }, ctx);
    expect(globResult.structured).toMatchObject({
      files: expect.arrayContaining(["src/app.ts", "src/util.ts"]),
    });

    const grepResult = await createGrepTool().invoke(
      { pattern: "backend", glob: "src/*.ts", output_mode: "files_with_matches" },
      ctx,
    );
    expect(grepResult.structured).toMatchObject({
      files: ["src/app.ts"],
      total: 1,
    });
  });
});

describe("workspace search tools", () => {
  it("globs within the workspace and ignores build/system directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-glob-"));
    tempDirs.push(dir);

    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "dist"), { recursive: true });
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(dir, ".git"), { recursive: true });

    await writeFile(join(dir, "src", "a.ts"), "export const a = 1;\n", "utf8");
    await writeFile(join(dir, "src", "b.ts"), "export const b = 2;\n", "utf8");
    await writeFile(join(dir, "dist", "ignored.ts"), "ignored\n", "utf8");
    await writeFile(join(dir, "node_modules", "pkg", "ignored.ts"), "ignored\n", "utf8");
    await writeFile(join(dir, ".git", "ignored.ts"), "ignored\n", "utf8");

    const ctx = createToolContext(dir);
    const result = await createGlobTool({ maxResults: 1 }).invoke({ pattern: "**/*.ts" }, ctx);

    expect(result.content).toContain("src/");
    expect(result.content).not.toContain("dist/ignored.ts");
    expect(result.content).not.toContain("node_modules");
    expect(result.content).toMatch(/truncated/i);
  });

  it("greps content/files/count modes with filtering and pagination", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-grep-"));
    tempDirs.push(dir);

    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "const target = 1;\nconst alpha = target;\n", "utf8");
    await writeFile(join(dir, "src", "b.ts"), "const target = 2;\n", "utf8");
    await writeFile(join(dir, "src", "c.js"), "const target = 3;\n", "utf8");

    const ctx = createToolContext(dir);
    const tool = createGrepTool({ defaultHeadLimit: 1 });

    const filesResult = await tool.invoke(
      { pattern: "target", glob: "src/*.ts", output_mode: "files_with_matches" },
      ctx,
    );
    expect(filesResult.content).toContain("src/a.ts");
    expect(filesResult.content).toContain("src/b.ts");
    expect(filesResult.content).not.toContain("src/c.js");

    const contentResult = await tool.invoke(
      { pattern: "target", glob: "src/*.ts", output_mode: "content", head_limit: 1, offset: 1 },
      ctx,
    );
    expect(contentResult.content).toContain("pagination");
    expect(contentResult.content).toContain("src/");

    const countResult = await tool.invoke(
      { pattern: "target", glob: "src/*.ts", output_mode: "count" },
      ctx,
    );
    expect(countResult.content).toContain("occurrences");
    expect(countResult.content).toContain("src/a.ts");
  });
});

describe("coding toolset", () => {
  it("exposes enterprise coding tools from agent-tools instead of local demo implementations", () => {
    const names = createCodingToolset().map((tool) => tool.name);
    expect(names).toEqual([
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "git_status",
      "run_checks",
      "Bash",
    ]);
  });
});

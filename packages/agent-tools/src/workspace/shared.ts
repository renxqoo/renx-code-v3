import { createHash } from "node:crypto";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

import type { AgentStatePatch, ToolContext } from "@renx/agent";

const WORKSPACE_TOOL_STATE_KEY = "__workspaceTools";
const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
]);
const KNOWN_BINARY_EXTENSIONS = new Set([
  ".7z",
  ".bin",
  ".class",
  ".dll",
  ".dylib",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".pyc",
  ".so",
  ".tar",
  ".tgz",
  ".wasm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

export interface WorkspaceRepoCommands {
  test?: string;
  lint?: string;
  build?: string;
  typecheck?: string;
}

export interface WorkspaceRepoFacts {
  commands?: WorkspaceRepoCommands;
}

export interface WorkspaceFileSnapshot {
  path: string;
  mtimeMs: number;
  size: number;
  sha256: string;
  partial: boolean;
}

export interface WorkspaceRecentRead {
  path: string;
  type: "text" | "notebook" | "image" | "pdf";
  offset: number;
  limit?: number;
  mtimeMs: number;
  size: number;
  sha256: string;
}

interface WorkspaceToolState {
  fileSnapshots: Record<string, WorkspaceFileSnapshot>;
  recentReads: Record<string, WorkspaceRecentRead>;
}

export interface WorkspaceFileEntry {
  fullPath: string;
  size?: number;
  mtimeMs?: number;
}

export interface ResolvedWorkspacePath {
  workspaceRoot: string;
  fullPath: string;
  relativePath: string;
}

export interface ReadTextFileOptions {
  maxReadBytes: number;
  binaryProbeBytes?: number;
}

export interface ReadTextRangeOptions extends ReadTextFileOptions {
  offset: number;
  limit?: number;
}

export interface DetailedTextFile {
  content: string;
  rawContent: string;
  size: number;
  mtimeMs: number;
  lineEnding: "\n" | "\r\n";
}

export interface StructuredPatchHunk {
  startLine: number;
  endLine: number;
  newStartLine: number;
  newEndLine: number;
  removed: string[];
  added: string[];
}

export const normalizePath = (value: string): string => value.split(sep).join("/");

export const getWorkspaceRoot = (ctx: ToolContext): string => {
  const workspaceRoot = ctx.runContext.metadata["workspaceRoot"];
  if (typeof workspaceRoot === "string" && workspaceRoot.length > 0) {
    return resolve(workspaceRoot);
  }
  return process.cwd();
};

const getFilesystemReadBackend = (
  ctx: ToolContext,
): NonNullable<ToolContext["backend"]> | undefined => {
  if (!ctx.backend?.readFile) return undefined;
  return ctx.backend.capabilities().filesystemRead ? ctx.backend : undefined;
};

const getFilesystemWriteBackend = (
  ctx: ToolContext,
): NonNullable<ToolContext["backend"]> | undefined => {
  if (!ctx.backend?.writeFile) return undefined;
  return ctx.backend.capabilities().filesystemWrite ? ctx.backend : undefined;
};

const getFilesystemListBackend = (
  ctx: ToolContext,
): NonNullable<ToolContext["backend"]> | undefined => {
  if (!ctx.backend?.listFiles) return undefined;
  return ctx.backend.capabilities().filesystemRead ? ctx.backend : undefined;
};

const getFilesystemStatBackend = (
  ctx: ToolContext,
): NonNullable<ToolContext["backend"]> | undefined => {
  if (!ctx.backend?.statPath) return undefined;
  return ctx.backend.capabilities().filesystemRead ? ctx.backend : undefined;
};

const toResolvedEntryPath = (basePath: string, entryPath: string): string =>
  isAbsolute(entryPath) ? resolve(entryPath) : resolve(basePath, entryPath);

const toMtimeMs = (modifiedAt: string | undefined): number => {
  if (!modifiedAt) return Date.now();
  const parsed = Date.parse(modifiedAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
};

const getBackendFileInfo = async (
  ctx: ToolContext,
  fullPath: string,
): Promise<{ size?: number; mtimeMs?: number } | undefined> => {
  const statBackend = getFilesystemStatBackend(ctx);
  if (statBackend?.statPath) {
    try {
      const matched = await statBackend.statPath(fullPath);
      if (matched) {
        return {
          ...(matched.size !== undefined ? { size: matched.size } : {}),
          ...(matched.modifiedAt ? { mtimeMs: toMtimeMs(matched.modifiedAt) } : {}),
        };
      }
    } catch {
      return undefined;
    }
  }

  const backend = getFilesystemListBackend(ctx);
  if (!backend?.listFiles) return undefined;
  try {
    const parentPath = dirname(fullPath);
    const entries = await backend.listFiles(parentPath);
    const matched = entries.find((entry) => {
      return normalizePath(toResolvedEntryPath(parentPath, entry.path)) === normalizePath(fullPath);
    });
    if (!matched) return undefined;
    return {
      ...(matched.size !== undefined ? { size: matched.size } : {}),
      ...(matched.modifiedAt ? { mtimeMs: toMtimeMs(matched.modifiedAt) } : {}),
    };
  } catch {
    return undefined;
  }
};

const readTextFileDetailedFromBackend = async (
  ctx: ToolContext,
  fullPath: string,
  options: ReadTextFileOptions,
): Promise<DetailedTextFile> => {
  const backend = getFilesystemReadBackend(ctx);
  if (!backend?.readFile) {
    throw new Error(`No filesystem read backend is available for ${fullPath}`);
  }
  const rawContent = await backend.readFile(fullPath);
  const size = Buffer.byteLength(rawContent, "utf8");
  if (size > options.maxReadBytes) {
    throw new Error(
      `File is too large to read at once (${size} bytes). Use offset/limit or increase the read budget.`,
    );
  }
  if (KNOWN_BINARY_EXTENSIONS.has(extname(fullPath).toLowerCase())) {
    throw new Error(`Refusing to read binary file: ${fullPath}`);
  }

  const binaryProbeBytes = Math.max(256, options.binaryProbeBytes ?? 4_096);
  if (looksBinary(Buffer.from(rawContent, "utf8").subarray(0, binaryProbeBytes))) {
    throw new Error(`Refusing to read binary file: ${fullPath}`);
  }

  const metadata = await getBackendFileInfo(ctx, fullPath);
  return {
    rawContent,
    content: rawContent.replaceAll("\r\n", "\n"),
    size,
    mtimeMs: metadata?.mtimeMs ?? Date.now(),
    lineEnding: detectLineEnding(rawContent),
  };
};

const tryRealPath = async (target: string): Promise<string> => {
  try {
    return await realpath(target);
  } catch {
    return resolve(target);
  }
};

const materializePathWithinAncestor = async (target: string): Promise<string> => {
  const pending: string[] = [];
  let cursor = resolve(target);

  while (true) {
    try {
      const real = await realpath(cursor);
      return resolve(real, ...pending.reverse());
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) {
        return resolve(target);
      }
      pending.push(basename(cursor));
      cursor = parent;
    }
  }
};

const isPathInside = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export const resolveWorkspacePath = async (
  ctx: ToolContext,
  inputPath: string,
): Promise<ResolvedWorkspacePath> => {
  const workspaceRoot = getWorkspaceRoot(ctx);
  return resolvePathWithinWorkspace(workspaceRoot, workspaceRoot, inputPath);
};

export const resolvePathWithinWorkspace = async (
  workspaceRootInput: string,
  baseDirInput: string,
  inputPath: string,
): Promise<ResolvedWorkspacePath> => {
  const workspaceRoot = await tryRealPath(resolve(workspaceRootInput));
  const absoluteBase = isAbsolute(baseDirInput)
    ? resolve(baseDirInput)
    : resolve(workspaceRoot, baseDirInput);
  const canonicalBase = await materializePathWithinAncestor(absoluteBase);

  if (!isPathInside(workspaceRoot, canonicalBase)) {
    throw new Error(`Base path is outside the workspace: ${baseDirInput}`);
  }

  const absolutePath = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(canonicalBase, inputPath);
  const canonicalTarget = await materializePathWithinAncestor(absolutePath);

  if (!isPathInside(workspaceRoot, canonicalTarget)) {
    throw new Error(`Path is outside the workspace: ${inputPath}`);
  }

  return {
    workspaceRoot,
    fullPath: canonicalTarget,
    relativePath: normalizePath(relative(workspaceRoot, canonicalTarget)),
  };
};

const looksBinary = (buffer: Buffer): boolean => {
  if (buffer.length === 0) return false;
  let suspicious = 0;
  for (const byte of buffer) {
    if (byte === 0) return true;
    const printable = byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126);
    if (!printable) suspicious += 1;
  }
  return suspicious / buffer.length > 0.2;
};

const detectLineEnding = (content: string): "\n" | "\r\n" =>
  content.includes("\r\n") ? "\r\n" : "\n";

const probeBinary = async (fullPath: string, binaryProbeBytes: number): Promise<void> => {
  const handle = await open(fullPath, "r");
  try {
    const probeBuffer = Buffer.alloc(binaryProbeBytes);
    const { bytesRead } = await handle.read(probeBuffer, 0, binaryProbeBytes, 0);
    if (looksBinary(probeBuffer.subarray(0, bytesRead))) {
      throw new Error(`Refusing to read binary file: ${fullPath}`);
    }
  } finally {
    await handle.close();
  }
};

export const readTextFileDetailed = async (
  ctx: ToolContext,
  fullPath: string,
  options: ReadTextFileOptions,
): Promise<DetailedTextFile> => {
  if (getFilesystemReadBackend(ctx)) {
    return await readTextFileDetailedFromBackend(ctx, fullPath, options);
  }
  const info = await stat(fullPath);
  if (!info.isFile()) {
    throw new Error(`Path is not a file: ${fullPath}`);
  }
  if (info.size > options.maxReadBytes) {
    throw new Error(
      `File is too large to read at once (${info.size} bytes). Use offset/limit or increase the read budget.`,
    );
  }
  if (KNOWN_BINARY_EXTENSIONS.has(extname(fullPath).toLowerCase())) {
    throw new Error(`Refusing to read binary file: ${fullPath}`);
  }

  const binaryProbeBytes = Math.max(256, options.binaryProbeBytes ?? 4_096);
  await probeBinary(fullPath, binaryProbeBytes);

  const rawContent = await readFile(fullPath, "utf8");
  return {
    rawContent,
    content: rawContent.replaceAll("\r\n", "\n"),
    size: info.size,
    mtimeMs: info.mtimeMs,
    lineEnding: detectLineEnding(rawContent),
  };
};

export const readTextFile = async (
  ctx: ToolContext,
  fullPath: string,
  options: ReadTextFileOptions,
): Promise<{ content: string; size: number; mtimeMs: number }> => {
  const detailed = await readTextFileDetailed(ctx, fullPath, options);
  return {
    content: detailed.content,
    size: detailed.size,
    mtimeMs: detailed.mtimeMs,
  };
};

export const readTextFileRange = async (
  ctx: ToolContext,
  fullPath: string,
  options: ReadTextRangeOptions,
): Promise<{
  content: string;
  size: number;
  mtimeMs: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  partial: boolean;
}> => {
  const backend = getFilesystemReadBackend(ctx);
  if (backend?.readFile) {
    const rawContent = await backend.readFile(fullPath);
    if (KNOWN_BINARY_EXTENSIONS.has(extname(fullPath).toLowerCase())) {
      throw new Error(`Refusing to read binary file: ${fullPath}`);
    }
    const binaryProbeBytes = Math.max(256, options.binaryProbeBytes ?? 4_096);
    if (looksBinary(Buffer.from(rawContent, "utf8").subarray(0, binaryProbeBytes))) {
      throw new Error(`Refusing to read binary file: ${fullPath}`);
    }

    const content = rawContent.replaceAll("\r\n", "\n");
    const lines = content.split("\n");
    const startLine = Math.max(1, options.offset);
    const endLine = Math.min(
      lines.length,
      options.limit === undefined ? lines.length : startLine + options.limit - 1,
    );
    const selected = lines.slice(startLine - 1, endLine).join("\n");
    if (Buffer.byteLength(selected, "utf8") > options.maxReadBytes) {
      throw new Error(
        `Requested range exceeds the read budget (${options.maxReadBytes} bytes). Narrow the range or increase the read budget.`,
      );
    }
    const metadata = await getBackendFileInfo(ctx, fullPath);
    return {
      content: selected,
      size: Buffer.byteLength(rawContent, "utf8"),
      mtimeMs: metadata?.mtimeMs ?? Date.now(),
      totalLines: lines.length,
      startLine,
      endLine: selected.length === 0 ? startLine - 1 : endLine,
      partial: startLine !== 1 || endLine < lines.length,
    };
  }
  const info = await stat(fullPath);
  if (!info.isFile()) {
    throw new Error(`Path is not a file: ${fullPath}`);
  }
  if (KNOWN_BINARY_EXTENSIONS.has(extname(fullPath).toLowerCase())) {
    throw new Error(`Refusing to read binary file: ${fullPath}`);
  }

  const binaryProbeBytes = Math.max(256, options.binaryProbeBytes ?? 4_096);
  await probeBinary(fullPath, binaryProbeBytes);

  const startLine = Math.max(1, options.offset);
  const endLineTarget =
    options.limit === undefined ? Number.POSITIVE_INFINITY : startLine + options.limit - 1;
  const selectedLines: string[] = [];
  let selectedBytes = 0;
  let totalLines = 0;

  const stream = createReadStream(fullPath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of reader) {
      totalLines += 1;
      if (totalLines < startLine || totalLines > endLineTarget) {
        continue;
      }
      selectedLines.push(line);
      selectedBytes += Buffer.byteLength(line, "utf8") + 1;
      if (selectedBytes > options.maxReadBytes) {
        throw new Error(
          `Requested range exceeds the read budget (${options.maxReadBytes} bytes). Narrow the range or increase the read budget.`,
        );
      }
    }
  } finally {
    reader.close();
    stream.close();
  }

  const endLine = selectedLines.length === 0 ? startLine - 1 : startLine + selectedLines.length - 1;
  return {
    content: selectedLines.join("\n"),
    size: info.size,
    mtimeMs: info.mtimeMs,
    totalLines,
    startLine,
    endLine,
    partial: startLine !== 1 || endLine < totalLines,
  };
};

export const hashContent = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

export const buildSnapshot = async (
  ctx: ToolContext,
  fullPath: string,
  content: string,
  partial: boolean,
): Promise<WorkspaceFileSnapshot> => {
  const backendMetadata = await getBackendFileInfo(ctx, fullPath);
  if (backendMetadata) {
    return {
      path: normalizePath(fullPath),
      mtimeMs: backendMetadata.mtimeMs ?? Date.now(),
      size: backendMetadata.size ?? Buffer.byteLength(content, "utf8"),
      sha256: hashContent(content),
      partial,
    };
  }

  if (getFilesystemReadBackend(ctx)) {
    return {
      path: normalizePath(fullPath),
      mtimeMs: Date.now(),
      size: Buffer.byteLength(content, "utf8"),
      sha256: hashContent(content),
      partial,
    };
  }

  const info = await (async () => {
    const statInfo = await stat(fullPath);
    return {
      size: statInfo.size,
      mtimeMs: statInfo.mtimeMs,
    };
  })();
  return {
    path: normalizePath(fullPath),
    mtimeMs: info.mtimeMs ?? Date.now(),
    size: info.size ?? Buffer.byteLength(content, "utf8"),
    sha256: hashContent(content),
    partial,
  };
};

const getWorkspaceToolState = (ctx: ToolContext): WorkspaceToolState => {
  const existing = ctx.runContext.state.scratchpad[WORKSPACE_TOOL_STATE_KEY];
  if (!existing || typeof existing !== "object") {
    return { fileSnapshots: {}, recentReads: {} };
  }
  const snapshots = (existing as { fileSnapshots?: Record<string, WorkspaceFileSnapshot> })
    .fileSnapshots;
  const recentReads = (existing as { recentReads?: Record<string, WorkspaceRecentRead> })
    .recentReads;
  return { fileSnapshots: { ...(snapshots ?? {}) }, recentReads: { ...(recentReads ?? {}) } };
};

export const buildWorkspaceToolPatch = (
  ctx: ToolContext,
  updater: (state: WorkspaceToolState) => WorkspaceToolState,
): AgentStatePatch => ({
  setScratchpad: {
    [WORKSPACE_TOOL_STATE_KEY]: updater(getWorkspaceToolState(ctx)),
  },
});

export const getTrackedSnapshot = (
  ctx: ToolContext,
  fullPath: string,
): WorkspaceFileSnapshot | undefined =>
  getWorkspaceToolState(ctx).fileSnapshots[normalizePath(fullPath)];

export const getRecentRead = (
  ctx: ToolContext,
  fullPath: string,
): WorkspaceRecentRead | undefined =>
  getWorkspaceToolState(ctx).recentReads[normalizePath(fullPath)];

export const buildSnapshotPatch = (
  ctx: ToolContext,
  snapshot: WorkspaceFileSnapshot,
): AgentStatePatch =>
  buildWorkspaceToolPatch(ctx, (state) => ({
    ...state,
    fileSnapshots: {
      ...state.fileSnapshots,
      [snapshot.path]: snapshot,
    },
  }));

export const buildRecentReadPatch = (
  ctx: ToolContext,
  recentRead: WorkspaceRecentRead,
): AgentStatePatch =>
  buildWorkspaceToolPatch(ctx, (state) => ({
    ...state,
    recentReads: {
      ...state.recentReads,
      [normalizePath(recentRead.path)]: recentRead,
    },
  }));

export const assertFreshSnapshot = async (
  ctx: ToolContext,
  snapshot: WorkspaceFileSnapshot,
  fullPath: string,
  currentContent: string,
): Promise<void> => {
  const backendMetadata = await getBackendFileInfo(ctx, fullPath);
  if ((backendMetadata?.mtimeMs ?? Number.POSITIVE_INFINITY) <= snapshot.mtimeMs) return;
  if (!backendMetadata && !getFilesystemReadBackend(ctx)) {
    const info = await stat(fullPath);
    if (info.mtimeMs <= snapshot.mtimeMs) return;
  }
  if (hashContent(currentContent) === snapshot.sha256) return;
  throw new Error(
    "File has been modified since read. Read it again before editing or overwriting it.",
  );
};

export const formatExcerpt = (
  content: string,
  offset: number,
  limit?: number,
): {
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  partial: boolean;
} => {
  const lines = content.split("\n");
  const totalLines = lines.length;
  const startLine = Math.max(1, offset);
  const endLine = Math.min(totalLines, limit === undefined ? totalLines : startLine + limit - 1);
  const excerpt = lines
    .slice(startLine - 1, endLine)
    .map((line, index) => `${startLine + index}: ${line}`)
    .join("\n");
  return {
    content: excerpt,
    totalLines,
    startLine,
    endLine,
    partial: startLine !== 1 || endLine < totalLines,
  };
};

export const restoreLineEndings = (content: string, lineEnding: "\n" | "\r\n"): string =>
  lineEnding === "\r\n" ? content.replaceAll("\n", "\r\n") : content;

export const buildStructuredPatch = (
  originalContent: string | null,
  updatedContent: string,
): StructuredPatchHunk[] => {
  const originalLines = (originalContent ?? "").split("\n");
  const updatedLines = updatedContent.split("\n");

  let prefix = 0;
  while (
    prefix < originalLines.length &&
    prefix < updatedLines.length &&
    originalLines[prefix] === updatedLines[prefix]
  ) {
    prefix += 1;
  }

  let originalSuffix = originalLines.length - 1;
  let updatedSuffix = updatedLines.length - 1;
  while (
    originalSuffix >= prefix &&
    updatedSuffix >= prefix &&
    originalLines[originalSuffix] === updatedLines[updatedSuffix]
  ) {
    originalSuffix -= 1;
    updatedSuffix -= 1;
  }

  if (prefix === originalLines.length && prefix === updatedLines.length) {
    return [];
  }

  return [
    {
      startLine: prefix + 1,
      endLine: Math.max(prefix, originalSuffix + 1),
      newStartLine: prefix + 1,
      newEndLine: Math.max(prefix, updatedSuffix + 1),
      removed: originalLines.slice(prefix, originalSuffix + 1),
      added: updatedLines.slice(prefix, updatedSuffix + 1),
    },
  ];
};

export const writeTextAtomic = async (
  ctx: ToolContext,
  fullPath: string,
  content: string,
): Promise<void> => {
  const backend = getFilesystemWriteBackend(ctx);
  if (backend?.writeFile) {
    await backend.writeFile(fullPath, content);
    return;
  }
  await mkdir(dirname(fullPath), { recursive: true });
  const tempPath = `${fullPath}.renx-tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tempPath, content, "utf8");
    try {
      await rename(tempPath, fullPath);
    } catch {
      await rm(fullPath, { force: true });
      await rename(tempPath, fullPath);
    }
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
};

export const collectWorkspaceFiles = async (
  ctx: ToolContext,
  root: string,
  searchPath: string,
  ignoredDirectories: ReadonlySet<string> = DEFAULT_IGNORED_DIRECTORIES,
): Promise<WorkspaceFileEntry[]> => {
  const backend = getFilesystemListBackend(ctx);
  if (backend?.listFiles) {
    try {
      const entries = await backend.listFiles(searchPath);
      const files: WorkspaceFileEntry[] = [];

      for (const entry of entries) {
        const fullPath = toResolvedEntryPath(searchPath, entry.path);
        if (entry.isDirectory) {
          const name = basename(fullPath);
          if (ignoredDirectories.has(name)) continue;
          if (!isPathInside(root, fullPath)) continue;
          files.push(...(await collectWorkspaceFiles(ctx, root, fullPath, ignoredDirectories)));
          continue;
        }
        files.push({
          fullPath,
          ...(entry.size !== undefined ? { size: entry.size } : {}),
          ...(entry.modifiedAt ? { mtimeMs: toMtimeMs(entry.modifiedAt) } : {}),
        });
      }

      return files.sort((left, right) =>
        normalizePath(relative(root, left.fullPath)).localeCompare(
          normalizePath(relative(root, right.fullPath)),
        ),
      );
    } catch {
      if (getFilesystemReadBackend(ctx)) {
        await getFilesystemReadBackend(ctx)!.readFile!(searchPath);
        return [{ fullPath: searchPath }];
      }
      throw new Error(`Path is not accessible: ${searchPath}`);
    }
  }
  const info = await stat(searchPath);
  if (info.isFile()) {
    return [{ fullPath: searchPath, size: info.size, mtimeMs: info.mtimeMs }];
  }

  const entries = await (
    await import("node:fs/promises")
  ).readdir(searchPath, { withFileTypes: true });
  const files: WorkspaceFileEntry[] = [];

  for (const entry of entries) {
    const fullPath = resolve(searchPath, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue;
      if (!isPathInside(root, fullPath)) continue;
      files.push(...(await collectWorkspaceFiles(ctx, root, fullPath, ignoredDirectories)));
      continue;
    }
    const fileInfo = await stat(fullPath);
    files.push({ fullPath, size: fileInfo.size, mtimeMs: fileInfo.mtimeMs });
  }

  return files.sort((left, right) =>
    normalizePath(relative(root, left.fullPath)).localeCompare(
      normalizePath(relative(root, right.fullPath)),
    ),
  );
};

export const pathExists = async (ctx: ToolContext, fullPath: string): Promise<boolean> => {
  try {
    await readTextFileDetailed(ctx, fullPath, { maxReadBytes: Number.MAX_SAFE_INTEGER });
    return true;
  } catch (error) {
    if (error instanceof Error && /binary file/i.test(error.message)) {
      return true;
    }
    return false;
  }
};

const escapeRegExp = (value: string): string => value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");

export const globToRegExp = (pattern: string): RegExp => {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    const next = pattern[index + 1];

    if (char === "*") {
      if (next === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "{") {
      const end = pattern.indexOf("}", index);
      if (end > index) {
        const parts = pattern
          .slice(index + 1, end)
          .split(",")
          .map((part) => escapeRegExp(part));
        source += `(${parts.join("|")})`;
        index = end;
        continue;
      }
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`);
};

export const applyPagination = <T>(
  items: T[],
  offset: number,
  limit?: number,
): { items: T[]; appliedOffset?: number; appliedLimit?: number } => {
  const safeOffset = Math.max(0, offset);
  const sliced = items.slice(safeOffset, limit === undefined ? undefined : safeOffset + limit);
  const appliedLimit = limit !== undefined && items.length - safeOffset > limit ? limit : undefined;
  return {
    items: sliced,
    ...(safeOffset > 0 ? { appliedOffset: safeOffset } : {}),
    ...(appliedLimit !== undefined ? { appliedLimit } : {}),
  };
};

export const renderPaginationNote = (appliedLimit?: number, appliedOffset?: number): string => {
  const parts: string[] = [];
  if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`);
  if (appliedOffset !== undefined) parts.push(`offset: ${appliedOffset}`);
  return parts.length > 0 ? `\n\n[Showing results with pagination = ${parts.join(", ")}]` : "";
};

export const toWorkspaceRelativePath = (workspaceRoot: string, fullPath: string): string =>
  normalizePath(relative(workspaceRoot, fullPath));

export const getRepoCommand = (
  ctx: ToolContext,
  preset: "test" | "lint" | "build" | "typecheck" | "auto" | undefined,
): string | undefined => {
  const repoFacts = ctx.runContext.metadata["repoFacts"] as WorkspaceRepoFacts | undefined;
  const commands = repoFacts?.commands;
  if (!commands) return undefined;
  switch (preset) {
    case "test":
      return commands.test;
    case "lint":
      return commands.lint;
    case "build":
      return commands.build;
    case "typecheck":
      return commands.typecheck;
    case "auto":
      return commands.test ?? commands.typecheck ?? commands.lint ?? commands.build;
    default:
      return commands.test;
  }
};

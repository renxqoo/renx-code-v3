/**
 * Memory file detection utilities.
 *
 * 1:1 replicate of claude-code-source/src/utils/memoryFileDetection.ts.
 *
 * Detects whether a file path is a Claude-managed memory file
 * (auto-memory, session memory, transcripts, agent-memory) vs user-managed
 * instruction files (CLAUDE.md, .claude/rules/).
 *
 * Adapted for the SDK architecture: all paths that would normally come from
 * global state (configDir, memoryBaseDir, agentMemoryDir) are injected as
 * parameters via the DetectionContext interface.
 */

import { normalize, sep } from "node:path";

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

const IS_WINDOWS = process.platform === "win32";

/**
 * Normalize path separators to posix (/).
 * Does NOT translate drive encoding.
 */
function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/**
 * Convert a path to a stable string-comparable form: forward-slash separated,
 * and on Windows, lowercased (Windows filesystems are case-insensitive).
 * On Linux/macOS, preserves case for case-sensitive filesystems.
 */
function toComparable(p: string): string {
  const posixForm = toPosix(p);
  return IS_WINDOWS ? posixForm.toLowerCase() : posixForm;
}

// ---------------------------------------------------------------------------
// Detection context (injected paths)
// ---------------------------------------------------------------------------

/**
 * Context providing the directory paths needed for memory detection.
 *
 * In claude-code-source these come from global state (getClaudeConfigHomeDir,
 * getMemoryBaseDir, etc.). In the SDK they are injected by the host.
 */
export interface MemoryDetectionContext {
  /** The auto-memory directory path (e.g., ~/.claude/projects/<slug>/memory). */
  memoryDir: string;
  /** Whether auto-memory is enabled. Default: true. */
  autoMemoryEnabled?: boolean;
  /** The config home directory (e.g., ~/.claude). Required for session file detection. */
  configDir?: string;
  /** The memory base directory (e.g., ~/.claude/projects). Required for comprehensive detection. */
  memoryBaseDir?: string;
  /** Team memory directory path. If provided, team paths are recognized. */
  teamDir?: string;
  /** Whether team memory is enabled. */
  teamEnabled?: boolean;
  /** Agent memory directories to recognize. */
  agentMemoryDirs?: string[];
}

// ---------------------------------------------------------------------------
// Session file detection
// ---------------------------------------------------------------------------

/**
 * Detects if a file path is a session-related file.
 * Returns the type of session file or null if not a session file.
 *
 * 1:1 replicate of claude-code-source/src/utils/memoryFileDetection.ts.
 *
 * @param filePath The file path to check.
 * @param configDir Optional config home directory. When provided, paths not
 *   under this directory are rejected (security boundary).
 */
export function detectSessionFileType(
  filePath: string,
  configDir?: string,
): "session_memory" | "session_transcript" | null {
  const normalized = toComparable(filePath);

  // Security: validate the file is under the config directory
  if (configDir) {
    const configDirCmp = toComparable(configDir);
    if (!normalized.startsWith(configDirCmp)) {
      return null;
    }
  }

  if (normalized.includes("/session-memory/") && normalized.endsWith(".md")) {
    return "session_memory";
  }
  if (normalized.includes("/projects/") && normalized.endsWith(".jsonl")) {
    return "session_transcript";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Auto-memory file detection
// ---------------------------------------------------------------------------

/**
 * Check if a file path is within the auto-memory directory.
 */
export function isAutoMemFile(
  filePath: string,
  memoryDir: string,
  enabled: boolean = true,
): boolean {
  if (!enabled) return false;
  const normalizedTarget = normalize(filePath);
  const normalizedBase = normalize(memoryDir);
  const baseWithSep = normalizedBase.endsWith(sep) ? normalizedBase : normalizedBase + sep;
  return normalizedTarget.startsWith(baseWithSep);
}

// ---------------------------------------------------------------------------
// Memory scope
// ---------------------------------------------------------------------------

export type MemoryScope = "personal" | "team";

/**
 * Determine which memory store (if any) a path belongs to.
 * Returns "team" for team memory paths, "personal" for auto-memory, or null.
 */
export function memoryScopeForPath(
  filePath: string,
  memoryDir: string,
  teamDirOrEnabled?: string | boolean,
  enabled: boolean = true,
): MemoryScope | null {
  // Handle overloaded 3rd param: boolean = enabled flag, string = teamDir
  let teamDir: string | undefined;
  if (typeof teamDirOrEnabled === "boolean") {
    enabled = teamDirOrEnabled;
  } else {
    teamDir = teamDirOrEnabled;
  }

  // Check team paths first (team dir is under auto-mem, so team first)
  if (teamDir && isPathWithin(filePath, teamDir)) {
    return "team";
  }
  if (isAutoMemFile(filePath, memoryDir, enabled)) {
    return "personal";
  }
  return null;
}

/**
 * Check if a path falls within a given directory.
 */
function isPathWithin(filePath: string, dir: string): boolean {
  const normalizedTarget = normalize(filePath);
  const normalizedBase = normalize(dir);
  const baseWithSep = normalizedBase.endsWith(sep) ? normalizedBase : normalizedBase + sep;
  return normalizedTarget.startsWith(baseWithSep);
}

// ---------------------------------------------------------------------------
// Session pattern detection
// ---------------------------------------------------------------------------

/**
 * Detect session-related glob patterns.
 * Checks if a glob pattern string could match session files.
 *
 * 1:1 replicate of claude-code-source/src/utils/memoryFileDetection.ts.
 */
export function detectSessionPatternType(
  pattern: string,
): "session_memory" | "session_transcript" | null {
  const normalized = toPosix(pattern);
  if (
    normalized.includes("session-memory") &&
    (normalized.includes(".md") || normalized.endsWith("*"))
  ) {
    return "session_memory";
  }
  if (
    normalized.includes(".jsonl") ||
    (normalized.includes("projects") && normalized.includes("*.jsonl"))
  ) {
    return "session_transcript";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Agent-memory detection
// ---------------------------------------------------------------------------

/**
 * Check if a file path is within any agent memory directory.
 */
function isAgentMemFile(filePath: string, agentMemoryDirs?: string[]): boolean {
  if (!agentMemoryDirs || agentMemoryDirs.length === 0) return false;
  const normalized = toComparable(filePath);
  return agentMemoryDirs.some((dir) => {
    const dirCmp = toComparable(dir);
    return normalized === dirCmp || normalized.startsWith(dirCmp + "/");
  });
}

/**
 * Check if a path pattern includes agent memory paths.
 */
function isAgentMemoryPattern(pattern: string): boolean {
  const normalized = toPosix(pattern);
  return normalized.includes("agent-memory/") || normalized.includes("agent-memory-local/");
}

// ---------------------------------------------------------------------------
// Managed memory file detection
// ---------------------------------------------------------------------------

/**
 * Check if a file is a Claude-managed memory file (NOT user-managed instruction files).
 * Includes: auto-memory, team memory, agent memory, session memory/transcripts.
 * Excludes: CLAUDE.md, CLAUDE.local.md, .claude/rules/*.md (user-managed).
 *
 * 1:1 replicate of claude-code-source/src/utils/memoryFileDetection.ts.
 */
export function isAutoManagedMemoryFile(filePath: string, ctx: MemoryDetectionContext): boolean {
  if (isAutoMemFile(filePath, ctx.memoryDir, ctx.autoMemoryEnabled ?? true)) {
    return true;
  }
  if (ctx.teamDir && ctx.teamEnabled && isPathWithin(filePath, ctx.teamDir)) {
    return true;
  }
  if (detectSessionFileType(filePath, ctx.configDir) !== null) {
    return true;
  }
  if (isAgentMemFile(filePath, ctx.agentMemoryDirs)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Memory directory detection
// ---------------------------------------------------------------------------

/**
 * Check if a directory path is a memory-related directory.
 *
 * 1:1 replicate of claude-code-source/src/utils/memoryFileDetection.ts.
 * Checks auto-memory, agent-memory, team memory, session, and project directories.
 */
export function isMemoryDirectory(dirPath: string, ctx: MemoryDetectionContext): boolean {
  const normalizedCmp = toComparable(normalize(dirPath));

  // Agent memory directories
  if (
    ctx.autoMemoryEnabled !== false &&
    (normalizedCmp.includes("/agent-memory/") || normalizedCmp.includes("/agent-memory-local/"))
  ) {
    return true;
  }

  // Team memory directories
  if (ctx.teamDir && ctx.teamEnabled) {
    const teamDirCmp = toComparable(ctx.teamDir);
    if (normalizedCmp === teamDirCmp || normalizedCmp.startsWith(teamDirCmp + "/")) {
      return true;
    }
  }

  // Auto-memory directory
  if (ctx.autoMemoryEnabled !== false) {
    const autoMemDirCmp = toComparable(ctx.memoryDir.replace(/[/\\]+$/, ""));
    if (normalizedCmp === autoMemDirCmp || normalizedCmp.startsWith(autoMemDirCmp + "/")) {
      return true;
    }
  }

  // Session and project directories (under configDir or memoryBaseDir)
  const configDirCmp = ctx.configDir ? toComparable(ctx.configDir) : null;
  const memoryBaseCmp = ctx.memoryBaseDir ? toComparable(ctx.memoryBaseDir) : null;

  const underConfig = configDirCmp && normalizedCmp.startsWith(configDirCmp);
  const underMemoryBase = memoryBaseCmp && normalizedCmp.startsWith(memoryBaseCmp);

  if (!underConfig && !underMemoryBase) {
    return false;
  }

  if (normalizedCmp.includes("/session-memory/")) {
    return true;
  }
  if (underConfig && normalizedCmp.includes("/projects/")) {
    return true;
  }
  if (ctx.autoMemoryEnabled !== false && normalizedCmp.includes("/memory/")) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Shell command detection
// ---------------------------------------------------------------------------

/**
 * Convert a MinGW-style path (/c/Users/...) to native Windows path (C:\Users\...).
 * On non-Windows platforms, returns the path unchanged.
 */
function posixPathToWindowsPath(posixPath: string): string {
  const match = posixPath.match(/^\/([a-zA-Z])\/(.*)$/);
  if (match) {
    return `${match[1]!.toUpperCase()}:\\${match[2]!.replace(/\//g, "\\")}`;
  }
  return posixPath;
}

/**
 * Convert a native Windows path (C:\Users\...) to MinGW-style (/c/Users/...).
 * On non-Windows platforms, returns the path unchanged.
 */
function windowsPathToPosixPath(windowsPath: string): string {
  const match = windowsPath.match(/^([a-zA-Z]):[\\](.*)$/);
  if (match) {
    return `/${match[1]!.toLowerCase()}/${match[2]!.replace(/\\/g, "/")}`;
  }
  return windowsPath;
}

/**
 * Check if a shell command string targets memory files
 * by extracting absolute path tokens and checking them against memory
 * detection functions.
 *
 * 1:1 replicate of claude-code-source/src/utils/memoryFileDetection.ts.
 */
export function isShellCommandTargetingMemory(
  command: string,
  ctx: MemoryDetectionContext,
): boolean {
  const dirs = [
    ctx.configDir,
    ctx.memoryBaseDir,
    ctx.autoMemoryEnabled !== false ? ctx.memoryDir.replace(/[/\\]+$/, "") : undefined,
  ].filter(Boolean) as string[];

  // Quick check: does the command mention any relevant directory?
  const commandCmp = toComparable(command);
  const matchesAnyDir = dirs.some((d) => {
    if (commandCmp.includes(toComparable(d))) return true;
    if (IS_WINDOWS) {
      return commandCmp.includes(windowsPathToPosixPath(d).toLowerCase());
    }
    return false;
  });

  if (!matchesAnyDir) {
    return false;
  }

  // Extract absolute path-like tokens
  const matches = command.match(/(?:[A-Za-z]:[/\\]|\/)[^\s'"]+/g);
  if (!matches) {
    return false;
  }

  for (const match of matches) {
    const cleanPath = match.replace(/[,;|&>]+$/, "");
    // On Windows, convert MinGW /c/... to native
    const nativePath = IS_WINDOWS ? posixPathToWindowsPath(cleanPath) : cleanPath;

    if (isAutoManagedMemoryFile(nativePath, ctx) || isMemoryDirectory(nativePath, ctx)) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Pattern-based detection
// ---------------------------------------------------------------------------

/**
 * Check if a glob/pattern targets auto-managed memory files only.
 * Excludes CLAUDE.md, CLAUDE.local.md, .claude/rules/ (user-managed).
 *
 * 1:1 replicate of claude-code-source/src/utils/memoryFileDetection.ts.
 */
export function isAutoManagedMemoryPattern(
  pattern: string,
  autoMemoryEnabled: boolean = true,
): boolean {
  if (detectSessionPatternType(pattern) !== null) {
    return true;
  }
  if (autoMemoryEnabled && isAgentMemoryPattern(pattern)) {
    return true;
  }
  return false;
}

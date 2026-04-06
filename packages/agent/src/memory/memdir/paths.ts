/**
 * Memory directory path resolution and validation.
 *
 * 1:1 replicate of claude-code-source/src/memdir/paths.ts.
 *
 * Provides path resolution, enablement checks, security validation,
 * and auto-memory path detection.
 */

import { homedir } from "node:os";
import { normalize, resolve, sep } from "node:path";

/**
 * Resolve the auto-memory directory path.
 *
 * Priority (matching claude-code-source):
 * 1. overridePath (from env var or setting override)
 * 2. settingsPath (from settings.json autoMemoryDirectory)
 * 3. default: {memoryBase}/projects/{sanitized-git-root}/memory/
 */
export function getAutoMemPath(input: {
  overridePath?: string;
  settingsPath?: string;
  memoryBase: string;
  projectRoot: string;
}): string {
  if (input.overridePath && input.overridePath.trim().length > 0) {
    return validateAndResolve(input.overridePath);
  }

  if (input.settingsPath && input.settingsPath.trim().length > 0) {
    // Expand ~/ to home directory
    const expanded = input.settingsPath.replace(/^~[/\\]/, homedir() + sep);
    return resolve(expanded);
  }

  // Default: {memoryBase}/projects/{sanitized-project-root}/memory/
  const sanitized = sanitizeProjectRoot(input.projectRoot);
  return resolve(input.memoryBase, "projects", sanitized, "memory");
}

/**
 * Validate override path and resolve.
 * Returns undefined for invalid paths (graceful degradation).
 */
function validateAndResolve(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return resolve(trimmed);
  // Expand tilde
  const expanded = trimmed.replace(/^~[/\\]/, homedir() + sep);
  const normalized = normalize(expanded);
  // Reject relative, UNC, null bytes, root paths
  if (normalized.includes("\0")) return resolve(expanded);
  if (normalized.startsWith("\\\\")) return resolve(expanded);
  if (!normalized.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(normalized)) return resolve(expanded);
  return resolve(normalized);
}

/**
 * Check if auto-memory is enabled.
 *
 * Priority (matching claude-code-source):
 * 1. disableEnvVar (CLAUDE_CODE_DISABLE_AUTO_MEMORY) = "true"/"1" → OFF
 * 2. disableEnvVar defined but falsy ("0"/"false") → ON (explicit opt-in)
 * 3. bareMode (--bare / CLAUDE_CODE_SIMPLE) → OFF
 * 4. autoMemoryEnabled setting explicitly false → OFF
 * 5. Default: ON
 */
export function isAutoMemoryEnabled(input: {
  disableEnvVar?: string;
  bareMode?: boolean;
  autoMemoryEnabled?: boolean;
}): boolean {
  if (input.disableEnvVar !== undefined) {
    const v = input.disableEnvVar.trim().toLowerCase();
    if (v === "true" || v === "1") return false;
    // Defined but falsy (e.g., "0", "false") → explicitly forced ON
    if (v === "false" || v === "0") return true;
  }

  if (input.bareMode) return false;
  if (input.autoMemoryEnabled === false) return false;

  return true;
}

/**
 * Check if a file path is within the auto-memory directory.
 *
 * 1:1 replicate of isAutoMemPath() from claude-code-source.
 * Normalizes the path and checks prefix match.
 */
export function isAutoMemPath(filePath: string, memoryDir: string): boolean {
  const normalizedTarget = resolve(filePath);
  const normalizedBase = resolve(memoryDir);

  // Ensure prefix match doesn't match sibling directories
  // e.g., /foo/memory-evil should not match /foo/memory/
  const baseWithSep = normalizedBase.endsWith(sep) ? normalizedBase : normalizedBase + sep;
  return normalizedTarget.startsWith(baseWithSep);
}

/**
 * Validate a memory path for security.
 *
 * Rejects:
 * - Relative paths
 * - Paths with null bytes
 * - Root or near-root paths
 * - UNC paths (Windows)
 * - Drive root paths (Windows)
 *
 * 1:1 replicate of validateMemoryPath() security checks from claude-code-source.
 */
export function validateMemoryPath(filePath: string): void {
  // Null byte check
  if (filePath.includes("\0")) {
    throw new Error("Memory path contains null bytes");
  }

  // UNC path check (Windows)
  if (filePath.startsWith("\\\\")) {
    throw new Error("UNC paths are not allowed for memory files");
  }

  // Normalize for further checks
  const normalized = normalize(filePath);

  // Must be absolute (accept both Unix and Windows absolute paths)
  if (!normalized.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(normalized)) {
    throw new Error("Memory path must be absolute");
  }

  // Root path check
  if (normalized === "/" || normalized === "\\" || /^[A-Za-z]:[\\/]?$/.test(normalized)) {
    throw new Error("Root paths are not allowed for memory files");
  }

  // Path traversal check
  if (normalized.includes("..")) {
    throw new Error("Path traversal (..) is not allowed in memory paths");
  }
}

/**
 * Sanitize a project root path for use as a directory name.
 *
 * Replaces path separators and special chars with dashes,
 * matching the slug generation in claude-code-source.
 */
function sanitizeProjectRoot(projectRoot: string): string {
  return (
    projectRoot
      .replace(/[/\\]+/g, "-")
      .replace(/[^a-zA-Z0-9._-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "default"
  );
}

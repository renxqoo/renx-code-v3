/**
 * Team memory sync security utilities.
 *
 * 1:1 replicate of the security functions from
 * claude-code-source/src/memdir/teamMemPaths.ts.
 *
 * Provides path validation and sanitization for team memory
 * file operations, preventing path traversal, symlink escapes,
 * and injection attacks.
 */

/**
 * Error thrown when a path validation detects a traversal or injection attempt.
 */
export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathTraversalError";
  }
}

/**
 * Sanitize a file path key by rejecting dangerous patterns.
 * Checks for null bytes, URL-encoded traversals, and other injection vectors.
 *
 * 1:1 replicate of sanitizePathKey() from claude-code-source.
 */
export function sanitizePathKey(key: string): string {
  // Null bytes can truncate paths in C-based syscalls
  if (key.includes("\0")) {
    throw new PathTraversalError(`Null byte in path key: "${key}"`);
  }

  // URL-encoded traversals (e.g. %2e%2e%2f = ../)
  let decoded: string;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    decoded = key;
  }
  if (decoded !== key && (decoded.includes("..") || decoded.includes("/"))) {
    throw new PathTraversalError(`URL-encoded traversal in path key: "${key}"`);
  }

  // Unicode normalization attacks
  const normalized = key.normalize("NFKC");
  if (
    normalized !== key &&
    (normalized.includes("..") ||
      normalized.includes("/") ||
      normalized.includes("\\") ||
      normalized.includes("\0"))
  ) {
    throw new PathTraversalError(`Unicode-normalized traversal in path key: "${key}"`);
  }

  // Reject backslashes
  if (key.includes("\\")) {
    throw new PathTraversalError(`Backslash in path key: "${key}"`);
  }

  // Reject absolute paths
  if (key.startsWith("/")) {
    throw new PathTraversalError(`Absolute path key: "${key}"`);
  }

  return key;
}

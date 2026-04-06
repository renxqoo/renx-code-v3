/**
 * memdir barrel export.
 *
 * File-based memory directory module — 1:1 replicate of claude-code-source memdir.
 */
export {
  FRONTMATTER_REGEX,
  parseFrontmatter,
  quoteProblematicValues,
  type MemoryFrontmatter,
  type ParsedMemoryFile,
} from "./frontmatter";

export { scanMemoryFiles, readFileInRange, type MemoryFileHeader } from "./scanner";

export {
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES,
  truncateEntrypointContent,
  formatMemoryManifest,
  type EntrypointTruncation,
  type MemoryFileHeader as EntrypointMemoryFileHeader,
} from "./entrypoint";

export { FileMemoryDirStore, ensureMemoryDirExists } from "./store";

export { getAutoMemPath, isAutoMemPath, isAutoMemoryEnabled, validateMemoryPath } from "./paths";

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ToolResultStorageOptions {
  /** Directory for overflow text / binary artifacts. */
  resultsDir: string;
  /** Keep full content inline in ToolResult when under this size. */
  maxInlineChars: number;
  /** Bytes shown in preview prefix when spilling to disk. */
  previewChars: number;
  /** Prefix for filenames (e.g. bash). */
  filePrefix: string;
}

const defaultOptions = (): ToolResultStorageOptions => ({
  resultsDir: join(process.cwd(), ".renx-tool-results"),
  maxInlineChars: 80_000,
  previewChars: 8000,
  filePrefix: "bash",
});

export interface SpillTextResult {
  content: string;
  artifactPath?: string;
  truncated: boolean;
  totalChars: number;
}

/**
 * When `text` exceeds `maxInlineChars`, writes UTF-8 file and returns preview + path hint.
 */
export function spillTextIfLarge(
  text: string,
  partial?: Partial<ToolResultStorageOptions>,
): SpillTextResult {
  const opts = { ...defaultOptions(), ...partial };
  if (text.length <= opts.maxInlineChars) {
    return { content: text, truncated: false, totalChars: text.length };
  }
  mkdirSync(opts.resultsDir, { recursive: true });
  const id = randomBytes(8).toString("hex");
  const artifactPath = join(opts.resultsDir, `${opts.filePrefix}-${id}.txt`);
  writeFileSync(artifactPath, text, "utf8");
  const preview = text.slice(0, opts.previewChars);
  const rest = text.length - opts.previewChars;
  return {
    content: `${preview}\n\n… [${rest} more characters → ${artifactPath}]`,
    artifactPath,
    truncated: true,
    totalChars: text.length,
  };
}

export interface BinaryArtifactResult {
  path: string;
  bytesWritten: number;
}

/** Write binary payload (e.g. image) next to text spills. */
export function writeBinaryArtifact(
  data: Uint8Array,
  ext: string,
  partial?: Partial<ToolResultStorageOptions>,
): BinaryArtifactResult {
  const opts = { ...defaultOptions(), ...partial };
  mkdirSync(opts.resultsDir, { recursive: true });
  const id = randomBytes(8).toString("hex");
  const path = join(opts.resultsDir, `${opts.filePrefix}-${id}.${ext}`);
  writeFileSync(path, data);
  return { path, bytesWritten: data.byteLength };
}

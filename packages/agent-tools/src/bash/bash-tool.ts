/** Headless bash tool: no UI/React; use `ToolResult` only. */
import type { AgentTool, ToolContext, ToolResult } from "@renx/agent";
import { tmpdir } from "node:os";
import { cwd as processCwd } from "node:process";
import { join } from "node:path";
import { z } from "zod";

import { parseForSecurityFromAst, type TreeSitterBashPaths } from "./ast-security";
import { detectImageFromStdout } from "./image-output";
import { evaluatePipelineAndRedirects } from "./operators";
import type { BashPathPolicy } from "./path-policy";
import {
  type BashSecurityConfig,
  assessBashCommand,
  mergeBashSecurityConfig,
  splitShellSegments,
} from "./security";
import {
  spillTextIfLarge,
  writeBinaryArtifact,
  type ToolResultStorageOptions,
} from "./tool-result-storage";

const inputSchema = z.object({
  command: z.string().min(1, "command is required"),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
});

export type BashToolInput = z.infer<typeof inputSchema>;

export interface BashTreeSitterOptions {
  /** When false, skip AST gate (regex + structural only). Default true. */
  enabled?: boolean;
  /** Override path to tree-sitter-bash.wasm */
  bashWasmPath?: string;
}

export interface BashResultStorageOptions extends Partial<ToolResultStorageOptions> {
  /** Directory for spilled text / image binaries. Default `join(os.tmpdir(), 'renx-tool-results')`. */
  resultsDir?: string;
}

export interface CreateBashToolOptions {
  name?: string;
  description?: string;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  /** Hard cap on returned `content` string (after spill preview). */
  maxResultChars?: number;
  /**
   * Static command policy. Set `enterpriseDeepSecurity: true` for full Claude-parity
   * deep checks; default is lighter (extraDangerPatterns + segment rules only).
   */
  security?: Partial<BashSecurityConfig>;
  pathPolicy?: BashPathPolicy;
  blockSubshellParens?: boolean;
  resolveCwd?: (ctx: ToolContext, input: BashToolInput) => string | undefined;
  treeSitter?: BashTreeSitterOptions;
  /** Large stdout/stderr combined spill + image artifacts. */
  resultStorage?: BashResultStorageOptions;
  /** Detect PNG/JPEG/GIF/WebP at start of stdout and write artifact. Default true. */
  detectImageOutput?: boolean;
}

const DEFAULT_NAME = "bash";

/** Default tool `description` string sent to the LLM (not operator-facing documentation). */
export const BASH_TOOL_DEFAULT_DESCRIPTION = `Execute a shell command with explicit policy, sandbox, and approval controls.

Use bash for:
- repository search and inspection
- listing files and directories
- build, test, lint, and git commands
- focused environment checks

Prefer other tools when available:
- use read_file when you already know the file path
- use file_edit for precise edits to existing files
- use write_file for full-file writes

Platform guidance:
- Windows: prefer PowerShell command shapes such as Get-ChildItem, Get-Content, Select-String, and direct git/npm commands
- macOS/Linux: prefer rg, rg --files, ls, cat, find, and shell pipelines

Execution guidance:
- command is required
- cwd is optional; when omitted, the runtime uses the current workspace / process working directory
- timeoutMs is optional; default and maximum follow the active tool/host profile
- invocation is synchronous (one call returns after the process exits)
- use parallel tool calls for independent commands
- use && only when later commands depend on earlier ones
- commands run through explicit shell policy and sandbox profiles

Examples:
- Windows search: Get-ChildItem -Path src -Recurse | Select-String -Pattern 'TODO'
- Windows read: Get-Content -Raw package.json
- Unix search: rg "pattern" src
- Unix file discovery: rg --files src
- Git status: git status && git diff --stat`;

const DEFAULT_DESC = BASH_TOOL_DEFAULT_DESCRIPTION;

const READ_ONLY_HINT = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "pwd",
  "whoami",
  "id",
  "stat",
  "file",
  "wc",
  "grep",
  "rg",
  "find",
  "echo",
  "printf",
]);

function truncateText(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, max)}\n… [truncated ${s.length - max} characters]`;
}

/**
 * Heuristic for `AgentTool.isReadOnly` only — not a security boundary.
 * Uses `splitShellSegments` so `&&` / `|` inside quotes are not split.
 */
function isProbablyReadOnly(command: string): boolean {
  const segments = splitShellSegments(command.trim());
  if (segments === null || segments.length === 0) {
    return false;
  }
  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    const assign = /^[A-Za-z_][A-Za-z0-9_]*=/;
    while (i < tokens.length && assign.test(tokens[i]!)) {
      i++;
    }
    const first = tokens[i]?.replace(/^\\+/, "").toLowerCase() ?? "";
    if (!READ_ONLY_HINT.has(first)) {
      return false;
    }
  }
  return true;
}

function storageOpts(
  name: string,
  o?: BashResultStorageOptions,
): Partial<ToolResultStorageOptions> {
  return {
    resultsDir: o?.resultsDir ?? join(tmpdir(), "renx-tool-results"),
    maxInlineChars: o?.maxInlineChars ?? 80_000,
    previewChars: o?.previewChars ?? 8000,
    filePrefix: o?.filePrefix ?? name,
  };
}

export function createBashTool(options: CreateBashToolOptions = {}): AgentTool {
  const name = options.name ?? DEFAULT_NAME;
  const description = options.description ?? DEFAULT_DESC;
  const defaultTimeoutMs = Math.min(
    Math.max(options.defaultTimeoutMs ?? 120_000, 1_000),
    options.maxTimeoutMs ?? 600_000,
  );
  const maxTimeoutMs = options.maxTimeoutMs ?? 600_000;
  const maxResultChars = options.maxResultChars ?? 200_000;
  const security = mergeBashSecurityConfig(options.security);
  const pathPolicy = options.pathPolicy;
  const blockSubshellParens = options.blockSubshellParens ?? true;
  const detectImage = options.detectImageOutput !== false;
  const spillPartial = storageOpts(name, options.resultStorage);

  return {
    name,
    description,
    schema: inputSchema,
    capabilities: ["exec", "bash"],
    maxResultSizeChars: maxResultChars,
    isConcurrencySafe: () => false,
    isReadOnly: (input: unknown) => {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        return false;
      }
      return isProbablyReadOnly(parsed.data.command);
    },
    invoke: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          content: `Invalid bash tool input: ${parsed.error.message}`,
          metadata: { tool: name, error: "validation", issues: parsed.error.flatten() },
        };
      }
      const cmd = parsed.data.command.trim();
      const cwdResolved = parsed.data.cwd ?? options.resolveCwd?.(ctx, parsed.data) ?? undefined;
      const cwdForPaths = cwdResolved ?? pathPolicy?.workspaceRoot ?? processCwd();

      const verdict = assessBashCommand(cmd, security);
      if (!verdict.ok) {
        return {
          content: `[${verdict.code}] ${verdict.message}`,
          metadata: { tool: name, blocked: true, code: verdict.code },
        };
      }

      if (options.treeSitter?.enabled !== false) {
        const astPaths: Partial<TreeSitterBashPaths> | undefined =
          options.treeSitter?.bashWasmPath !== undefined
            ? { bashWasmPath: options.treeSitter.bashWasmPath }
            : undefined;
        const ast = await parseForSecurityFromAst(cmd, astPaths);
        if (ast.kind === "too-complex") {
          return {
            content: `[AST_TOO_COMPLEX] ${ast.reason}`,
            metadata: { tool: name, blocked: true, code: "AST_TOO_COMPLEX" },
          };
        }
      }

      const structural = evaluatePipelineAndRedirects(cmd, {
        cwdForPaths,
        blockSubshellParens,
        ...(pathPolicy !== undefined ? { pathPolicy } : {}),
      });
      if (!structural.ok) {
        return {
          content: `[${structural.code}] ${structural.message}`,
          metadata: { tool: name, blocked: true, code: structural.code },
        };
      }

      const backend = ctx.backend;
      if (!backend?.exec) {
        return {
          content: "No execution backend with exec() is configured; cannot run shell commands.",
          metadata: { tool: name, error: "no_exec_backend" },
        };
      }

      const caps = backend.capabilities();
      if (!caps.exec) {
        return {
          content: "Execution backend does not advertise exec capability.",
          metadata: { tool: name, error: "exec_disabled" },
        };
      }

      const timeoutMs = Math.min(parsed.data.timeoutMs ?? defaultTimeoutMs, maxTimeoutMs);
      try {
        const execOpts =
          cwdResolved !== undefined ? { cwd: cwdResolved, timeoutMs } : { timeoutMs };
        const result = await backend.exec(cmd, execOpts);

        let stdoutOut = result.stdout;
        let imageStructured: Record<string, unknown> | undefined;

        if (detectImage && result.stdout) {
          const img = detectImageFromStdout(result.stdout);
          if (img) {
            const buf = Buffer.from(result.stdout, "latin1");
            const art = writeBinaryArtifact(buf, img.ext, spillPartial);
            stdoutOut = `[image ${img.mime} → ${art.path} (${art.bytesWritten} bytes)]`;
            imageStructured = {
              image: { path: art.path, mime: img.mime, bytes: art.bytesWritten },
            };
          }
        }

        const combined = [
          stdoutOut ? `stdout:\n${stdoutOut}` : "",
          result.stderr ? `stderr:\n${result.stderr}` : "",
          `exit_code: ${result.exitCode}`,
        ]
          .filter(Boolean)
          .join("\n\n");

        const spilled = spillTextIfLarge(combined, spillPartial);
        const content = truncateText(spilled.content, maxResultChars);

        const structured: Record<string, unknown> = {
          exitCode: result.exitCode,
          stderr: result.stderr,
        };
        if (imageStructured) {
          structured.stdoutSummary = stdoutOut;
          Object.assign(structured, imageStructured);
        } else {
          structured.stdout = result.stdout;
        }
        if (spilled.artifactPath) {
          structured.textArtifactPath = spilled.artifactPath;
          structured.textSpilled = spilled.truncated;
          structured.textTotalChars = spilled.totalChars;
        }

        return {
          content,
          structured,
          metadata: {
            tool: name,
            cwd: cwdResolved ?? null,
            timeoutMs,
            ...(spilled.artifactPath ? { textArtifactPath: spilled.artifactPath } : {}),
            ...(imageStructured?.image as Record<string, unknown> | undefined),
          },
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: `Execution failed: ${message}`,
          metadata: { tool: name, error: "exec_exception" },
        };
      }
    },
  };
}

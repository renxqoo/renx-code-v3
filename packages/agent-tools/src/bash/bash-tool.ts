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
  command: z.string().min(1, "command is required").describe("The command to execute"),
  timeout: z
    .number()
    .int()
    .positive()
    .max(3_600_000)
    .optional()
    .describe("Optional timeout in milliseconds."),
  description: z
    .string()
    .optional()
    .describe(
      'Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk".',
    ),
  run_in_background: z
    .boolean()
    .optional()
    .describe("Set to true to run this command in the background."),
  dangerouslyDisableSandbox: z
    .boolean()
    .optional()
    .describe("Set this to true to run commands without sandboxing."),
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

const DEFAULT_NAME = "Bash";

/** Default tool `description` string sent to the LLM (not operator-facing documentation). */
export const BASH_TOOL_DEFAULT_DESCRIPTION = `Executes a given bash command and returns its output.

The working directory persists between commands, but shell state does not.

IMPORTANT: Avoid using this tool to run \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:

- File search: Use Glob (NOT find or ls)
- Content search: Use Grep (NOT grep or rg)
- Read files: Use Read (NOT cat/head/tail)
- Edit files: Use Edit (NOT sed/awk)
- Write files: Use Write (NOT echo >/cat <<EOF)
- Communication: Output text directly (NOT echo/printf)

While the Bash tool can do similar things, it's better to use the built-in tools as they provide a better user experience and make it easier to review tool calls and give permission.

# Instructions
- If your command will create new directories or files, first use this tool to run \`ls\` to verify the parent directory exists and is the correct location.
- Always quote file paths that contain spaces with double quotes in your command.
- You may specify an optional timeout in milliseconds.
- When issuing multiple commands:
  - If the commands are independent and can run in parallel, make multiple Bash tool calls in a single message.
  - If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together.
  - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.
  - DO NOT use newlines to separate commands.
- For git commands:
  - Prefer to create a new commit rather than amending an existing commit.
  - Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative.
  - Never skip hooks (--no-verify) or bypass signing unless the user has explicitly asked for it.`;

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
      const cwdResolved = options.resolveCwd?.(ctx, parsed.data) ?? undefined;
      const cwdForPaths = cwdResolved ?? pathPolicy?.workspaceRoot ?? processCwd();
      const requestMetadata = {
        ...(parsed.data.description ? { description: parsed.data.description } : {}),
        ...(parsed.data.run_in_background !== undefined
          ? { run_in_background: parsed.data.run_in_background }
          : {}),
        ...(parsed.data.dangerouslyDisableSandbox !== undefined
          ? { dangerouslyDisableSandbox: parsed.data.dangerouslyDisableSandbox }
          : {}),
      };

      const verdict = assessBashCommand(cmd, security);
      if (!verdict.ok) {
        return {
          content: `[${verdict.code}] ${verdict.message}`,
          metadata: { tool: name, blocked: true, code: verdict.code, ...requestMetadata },
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
            metadata: {
              tool: name,
              blocked: true,
              code: "AST_TOO_COMPLEX",
              ...requestMetadata,
            },
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
          metadata: { tool: name, blocked: true, code: structural.code, ...requestMetadata },
        };
      }

      const backend = ctx.backend;
      if (!backend?.exec) {
        return {
          content: "No execution backend with exec() is configured; cannot run shell commands.",
          metadata: { tool: name, error: "no_exec_backend", ...requestMetadata },
        };
      }

      const caps = backend.capabilities();
      if (!caps.exec) {
        return {
          content: "Execution backend does not advertise exec capability.",
          metadata: { tool: name, error: "exec_disabled", ...requestMetadata },
        };
      }

      const timeoutMs = Math.min(parsed.data.timeout ?? defaultTimeoutMs, maxTimeoutMs);
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
          ...(parsed.data.description ? { description: parsed.data.description } : {}),
          ...("dangerouslyDisableSandbox" in parsed.data
            ? { dangerouslyDisableSandbox: parsed.data.dangerouslyDisableSandbox }
            : {}),
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
            ...requestMetadata,
            ...(spilled.artifactPath ? { textArtifactPath: spilled.artifactPath } : {}),
            ...(imageStructured?.image as Record<string, unknown> | undefined),
          },
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: `Execution failed: ${message}`,
          metadata: { tool: name, error: "exec_exception", ...requestMetadata },
        };
      }
    },
  };
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { AgentTool } from "@renx/agent";
import { createToolCapabilityProfile } from "@renx/agent";
import { z } from "zod";

import { detectImageFromStdout } from "../bash/image-output";
import { spillTextIfLarge, writeBinaryArtifact } from "../bash/tool-result-storage";
import { registerBackgroundShellTask } from "../platform/background-task-store";
import { buildPlatformPatch, getPowerShellPolicy, nowIso } from "../platform/shared";
import {
  buildSnapshot,
  buildSnapshotPatch,
  getWorkspaceRoot,
  readTextFileDetailed,
  resolvePathWithinWorkspace,
  resolveWorkspacePath,
  writeTextAtomic,
} from "../workspace/shared";

const delay = async (ms: number): Promise<void> =>
  await new Promise<void>((resolve) => setTimeout(resolve, ms));

const NOTEBOOK_EDIT_TOOL_PROMPT = `Completely replaces the contents of a specific cell in a Jupyter notebook (.ipynb file) with new source. Jupyter notebooks are interactive documents that combine code, text, and visualizations, commonly used for data analysis and scientific computing. The notebook_path parameter must be an absolute path, not a relative path. The cell_number is 0-indexed. Use edit_mode=insert to add a new cell at the index specified by cell_number. Use edit_mode=delete to delete the cell at the index specified by cell_number.`;

const SLEEP_TOOL_PROMPT = `Wait for a specified duration. The user can interrupt the sleep at any time.

Use this when the user tells you to sleep or rest, when you have nothing to do, or when you're waiting for something.

You can call this concurrently with other tools - it won't interfere with them.

Prefer this over \`Bash(sleep ...)\` - it doesn't hold a shell process.`;

const POWERSHELL_TOOL_DESCRIPTION = `Executes a given PowerShell command with optional timeout. Working directory persists between commands; shell state (variables, functions) does not.

IMPORTANT: This tool is for terminal operations via PowerShell: git, npm, docker, and PS cmdlets. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.

Before executing the command, please follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use \`Get-ChildItem\` (or \`ls\`) to verify the parent directory exists and is the correct location

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes
   - Capture the output of the command.

PowerShell Syntax Notes:
   - Variables use $ prefix: $myVar = "value"
   - Escape character is backtick (\`), not backslash
   - Use Verb-Noun cmdlet naming: Get-ChildItem, Set-Location, New-Item, Remove-Item
   - Environment variables: read with \`$env:NAME\`, set with \`$env:NAME = "value"\`

Usage notes:
  - The command argument is required.
  - You can specify an optional timeout in milliseconds.
  - It is very helpful if you write a clear, concise description of what this command does.
  - You can use the \`run_in_background\` parameter to run the command in the background.
  - Avoid using PowerShell to run commands that have dedicated tools:
    - File search: Use Glob
    - Content search: Use Grep
    - Read files: Use Read
    - Edit files: Use Edit
    - Write files: Use Write
    - Communication: Output text directly
  - When issuing multiple commands:
    - If the commands are independent and can run in parallel, make multiple PowerShell tool calls in a single message.
    - If the commands depend on each other and must run sequentially, chain them in a single PowerShell call.
  - Do NOT prefix commands with \`cd\` or \`Set-Location\` -- the working directory is already set to the correct project directory automatically.`;

const POWERSHELL_READ_COMMANDS = new Set([
  "get-content",
  "get-childitem",
  "get-item",
  "get-location",
  "get-process",
  "get-service",
  "resolve-path",
  "select-string",
  "test-path",
  "where-object",
  "format-hex",
  "write-output",
]);

const POWERSHELL_WRITE_COMMANDS = new Set([
  "set-content",
  "add-content",
  "clear-content",
  "new-item",
  "remove-item",
  "rename-item",
  "move-item",
  "copy-item",
  "invoke-webrequest",
  "start-process",
]);

const POWERSHELL_CWD_COMMANDS = new Set(["set-location", "push-location", "pop-location"]);

const POWERSHELL_ALIASES = new Map<string, string>([
  ["cat", "get-content"],
  ["gc", "get-content"],
  ["type", "get-content"],
  ["dir", "get-childitem"],
  ["ls", "get-childitem"],
  ["gi", "get-item"],
  ["ni", "new-item"],
  ["mkdir", "new-item"],
  ["rm", "remove-item"],
  ["del", "remove-item"],
  ["erase", "remove-item"],
  ["ri", "remove-item"],
  ["rmdir", "remove-item"],
  ["ren", "rename-item"],
  ["move", "move-item"],
  ["mv", "move-item"],
  ["copy", "copy-item"],
  ["cp", "copy-item"],
  ["cd", "set-location"],
  ["sl", "set-location"],
  ["pushd", "push-location"],
  ["popd", "pop-location"],
]);

interface PowerShellPathConfig {
  pathParams: string[];
  positionalPathIndexes: number[];
}

const POWERSHELL_PATH_CONFIG: Record<string, PowerShellPathConfig> = {
  "get-content": {
    pathParams: ["-path", "-literalpath", "-pspath", "-lp"],
    positionalPathIndexes: [0],
  },
  "get-childitem": {
    pathParams: ["-path", "-literalpath", "-pspath", "-lp"],
    positionalPathIndexes: [0],
  },
  "get-item": {
    pathParams: ["-path", "-literalpath", "-pspath", "-lp"],
    positionalPathIndexes: [0],
  },
  "resolve-path": {
    pathParams: ["-path", "-literalpath", "-pspath", "-lp"],
    positionalPathIndexes: [0],
  },
  "test-path": {
    pathParams: ["-path", "-literalpath", "-pspath", "-lp"],
    positionalPathIndexes: [0],
  },
  "select-string": {
    pathParams: ["-path", "-literalpath", "-pspath", "-lp"],
    positionalPathIndexes: [0],
  },
  "format-hex": {
    pathParams: ["-path", "-literalpath", "-pspath", "-lp"],
    positionalPathIndexes: [0],
  },
  "set-content": {
    pathParams: ["-path", "-literalpath", "-pspath", "-lp"],
    positionalPathIndexes: [0],
  },
  "add-content": {
    pathParams: ["-path", "-literalpath", "-pspath", "-lp"],
    positionalPathIndexes: [0],
  },
  "clear-content": {
    pathParams: ["-path", "-literalpath", "-pspath", "-lp"],
    positionalPathIndexes: [0],
  },
  "new-item": {
    pathParams: ["-path", "-literalpath", "-pspath", "-lp"],
    positionalPathIndexes: [0],
  },
  "remove-item": {
    pathParams: ["-path", "-literalpath", "-pspath", "-lp"],
    positionalPathIndexes: [0],
  },
  "rename-item": {
    pathParams: ["-path", "-literalpath", "-pspath", "-lp"],
    positionalPathIndexes: [0],
  },
  "move-item": {
    pathParams: ["-path", "-literalpath", "-pspath", "-lp", "-destination"],
    positionalPathIndexes: [0, 1],
  },
  "copy-item": {
    pathParams: ["-path", "-literalpath", "-pspath", "-lp", "-destination"],
    positionalPathIndexes: [0, 1],
  },
  "out-file": {
    pathParams: ["-filepath", "-path", "-literalpath", "-pspath", "-lp"],
    positionalPathIndexes: [0],
  },
  "tee-object": {
    pathParams: ["-filepath", "-path", "-literalpath", "-pspath", "-lp"],
    positionalPathIndexes: [0],
  },
  "export-csv": {
    pathParams: ["-path", "-literalpath", "-pspath", "-lp"],
    positionalPathIndexes: [0],
  },
  "export-clixml": {
    pathParams: ["-path", "-literalpath", "-pspath", "-lp"],
    positionalPathIndexes: [0],
  },
  "set-location": {
    pathParams: ["-path", "-literalpath", "-pspath", "-lp"],
    positionalPathIndexes: [0],
  },
  "push-location": {
    pathParams: ["-path", "-literalpath", "-pspath", "-lp"],
    positionalPathIndexes: [0],
  },
};

const getPowerShellSegments = (command: string): string[] =>
  command
    .split(/[;\r\n|]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

const getPowerShellVerb = (segment: string): string => segment.split(/\s+/)[0]!.toLowerCase();

const isReadOnlyPowerShell = (command: string): boolean => {
  if (/[>][>]?/.test(command) || /\$[A-Za-z_][\w]*\s*=/.test(command)) {
    return false;
  }
  const segments = getPowerShellSegments(command);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    const verb = getPowerShellVerb(segment);
    if (POWERSHELL_WRITE_COMMANDS.has(verb)) {
      return false;
    }
    return POWERSHELL_READ_COMMANDS.has(verb);
  });
};

const detectBlockedSleepPattern = (command: string): string | null => {
  const first =
    command
      .trim()
      .split(/[;|&\r\n]/)[0]
      ?.trim() ?? "";
  const match = /^(?:start-sleep|sleep)(?:\s+-s(?:econds)?)?\s+(\d+)\s*$/i.exec(first);
  if (!match) return null;
  const seconds = Number.parseInt(match[1]!, 10);
  if (seconds < 2) return null;
  return `Start-Sleep ${seconds}`;
};

const canonicalizePowerShellVerb = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  return POWERSHELL_ALIASES.get(normalized) ?? normalized;
};

const tokenizePowerShell = (command: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      if (current.length > 0) {
        current += char;
      } else {
        current = char;
      }
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    if (char === ">") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      const next = command[index + 1];
      if (next === ">") {
        tokens.push(">>");
        index += 1;
      } else {
        tokens.push(">");
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
};

const splitPowerShellStatements = (command: string): string[] => {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      current += char;
      quote = char;
      continue;
    }

    if (char === ";" || char === "\n" || char === "\r") {
      if (current.trim().length > 0) {
        statements.push(current.trim());
      }
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim().length > 0) {
    statements.push(current.trim());
  }

  return statements;
};

const stripPowerShellQuotes = (value: string): string => {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
};

const extractPowerShellStatementTargets = (
  statement: string,
): {
  verb: string;
  paths: string[];
  redirects: string[];
  changesWorkingDirectory: boolean;
  hasFilesystemTarget: boolean;
} => {
  const tokens = tokenizePowerShell(statement);
  if (tokens.length === 0) {
    return {
      verb: "",
      paths: [],
      redirects: [],
      changesWorkingDirectory: false,
      hasFilesystemTarget: false,
    };
  }

  const verb = canonicalizePowerShellVerb(tokens[0]!);
  const config = POWERSHELL_PATH_CONFIG[verb];
  const redirects: string[] = [];
  const paths: string[] = [];
  const positionalValues: string[] = [];

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === ">" || token === ">>") {
      const target = tokens[index + 1];
      if (target) {
        redirects.push(stripPowerShellQuotes(target));
        index += 1;
      }
      continue;
    }
    if (!config) {
      continue;
    }
    if (token.startsWith("-")) {
      const lowered = token.toLowerCase();
      const colonIndex = lowered.indexOf(":");
      const paramName = colonIndex === -1 ? lowered : lowered.slice(0, colonIndex);
      if (!config.pathParams.includes(paramName)) {
        continue;
      }
      const colonValue = colonIndex === -1 ? undefined : token.slice(colonIndex + 1);
      if (colonValue && colonValue.length > 0) {
        paths.push(stripPowerShellQuotes(colonValue));
        continue;
      }
      const next = tokens[index + 1];
      if (next) {
        paths.push(stripPowerShellQuotes(next));
        index += 1;
      }
      continue;
    }
    positionalValues.push(stripPowerShellQuotes(token));
  }

  if (config) {
    for (const position of config.positionalPathIndexes) {
      const candidate = positionalValues[position];
      if (candidate) {
        paths.push(candidate);
      }
    }
  }

  return {
    verb,
    paths,
    redirects,
    changesWorkingDirectory: POWERSHELL_CWD_COMMANDS.has(verb),
    hasFilesystemTarget:
      !POWERSHELL_CWD_COMMANDS.has(verb) && (paths.length > 0 || redirects.length > 0),
  };
};

const validatePowerShellWorkspaceSafety = async (
  command: string,
  workspaceRoot: string,
  cwd: string,
): Promise<void> => {
  const statements = splitPowerShellStatements(command).map(extractPowerShellStatementTargets);
  const hasWorkingDirectoryChange = statements.some(
    (statement) => statement.changesWorkingDirectory,
  );
  const hasOtherFilesystemTarget = statements.some((statement) => statement.hasFilesystemTarget);

  if (hasWorkingDirectoryChange && statements.length > 1 && hasOtherFilesystemTarget) {
    throw new Error(
      "Compound PowerShell command changes the working directory before a filesystem operation. Split it into separate tool calls.",
    );
  }

  for (const statement of statements) {
    for (const rawPath of [...statement.paths, ...statement.redirects]) {
      const resolved = await resolvePathWithinWorkspace(workspaceRoot, cwd, rawPath);
      if (statement.verb === "remove-item" && resolved.fullPath === resolve(workspaceRoot)) {
        throw new Error("Dangerous PowerShell removal rejected for the workspace root.");
      }
    }
  }
};

export const createNotebookEditTool = (): AgentTool => {
  const schema = z.object({
    notebook_path: z.string().min(1),
    cell_id: z.string().optional(),
    new_source: z.string(),
    cell_type: z.enum(["code", "markdown"]).optional(),
    edit_mode: z.enum(["replace", "insert", "delete"]).optional(),
  });

  const getCellIndex = (cells: Array<{ id?: string }>, cellId: string | undefined): number => {
    if (!cellId) {
      return 0;
    }
    const byId = cells.findIndex((cell) => cell.id === cellId);
    if (byId >= 0) {
      return byId;
    }
    const cellMatch = /^cell-(\d+)$/.exec(cellId);
    if (cellMatch) {
      return Number.parseInt(cellMatch[1]!, 10);
    }
    if (/^\d+$/.test(cellId)) {
      return Number.parseInt(cellId, 10);
    }
    return -1;
  };

  return {
    name: "NotebookEdit",
    description: NOTEBOOK_EDIT_TOOL_PROMPT,
    schema,
    capabilities: ["requires-filesystem-read", "requires-filesystem-write"],
    profile: createToolCapabilityProfile({
      riskLevel: "high",
      capabilityTags: ["filesystem_read", "filesystem_write", "notebook"],
      sandboxExpectation: "workspace-write",
      auditCategory: "file_edit",
    }),
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      const resolved = await resolveWorkspacePath(ctx, parsed.notebook_path);
      const raw = (
        await readTextFileDetailed(ctx, resolved.fullPath, {
          maxReadBytes: Number.MAX_SAFE_INTEGER,
        })
      ).rawContent;
      const notebook = JSON.parse(raw) as {
        cells?: Array<{
          id?: string;
          cell_type?: "code" | "markdown";
          source?: string[] | string;
          metadata?: Record<string, unknown>;
          outputs?: unknown[];
          execution_count?: number | null;
        }>;
        metadata?: Record<string, unknown>;
        nbformat?: number;
        nbformat_minor?: number;
      };
      const cells = notebook.cells ?? [];
      const mode = parsed.edit_mode ?? "replace";
      const targetIndex = getCellIndex(cells, parsed.cell_id);

      if (mode !== "insert" && (targetIndex < 0 || targetIndex >= cells.length)) {
        throw new Error(`Notebook cell not found: ${parsed.cell_id ?? "missing cell_id"}`);
      }

      if (mode === "delete") {
        cells.splice(targetIndex, 1);
      } else if (mode === "insert") {
        const insertIndex = parsed.cell_id ? targetIndex + 1 : 0;
        const nextCellType = parsed.cell_type ?? "code";
        cells.splice(insertIndex, 0, {
          id: `cell-${Date.now()}`,
          cell_type: nextCellType,
          source: parsed.new_source,
          metadata: {},
          ...(nextCellType === "code" ? { execution_count: null, outputs: [] } : {}),
        });
      } else {
        const cell = cells[targetIndex]!;
        cell.source = Array.isArray(cell.source) ? [parsed.new_source] : parsed.new_source;
        if (parsed.cell_type) {
          cell.cell_type = parsed.cell_type;
        }
        if (cell.cell_type === "code") {
          cell.execution_count = null;
          cell.outputs = [];
        }
      }

      notebook.cells = cells;
      const nextContent = `${JSON.stringify(notebook, null, 2)}\n`;
      await writeTextAtomic(ctx, resolved.fullPath, nextContent);
      const snapshot = await buildSnapshot(
        ctx,
        resolved.fullPath,
        nextContent.replaceAll("\r\n", "\n"),
        false,
      );
      return {
        content: `Updated notebook ${resolved.relativePath}`,
        structured: {
          notebook_path: resolved.fullPath,
          cell_id: parsed.cell_id,
          new_source: parsed.new_source,
          cell_type: parsed.cell_type ?? "code",
          edit_mode: mode,
          original_file: raw,
          updated_file: nextContent,
        },
        statePatch: buildSnapshotPatch(ctx, snapshot),
      };
    },
  };
};

export const createPowerShellTool = (): AgentTool => {
  const schema = z.object({
    command: z.string().min(1),
    timeout: z.number().int().positive().optional(),
    description: z.string().optional(),
    run_in_background: z.boolean().optional(),
    dangerouslyDisableSandbox: z.boolean().optional(),
  });
  return {
    name: "PowerShell",
    description: POWERSHELL_TOOL_DESCRIPTION,
    schema,
    capabilities: ["requires-exec"],
    profile: createToolCapabilityProfile({
      riskLevel: "high",
      capabilityTags: ["process_exec", "powershell"],
      sandboxExpectation: "workspace-write",
      auditCategory: "exec",
    }),
    isConcurrencySafe: () => false,
    isReadOnly: (input) => {
      const parsed = schema.safeParse(input);
      return parsed.success ? isReadOnlyPowerShell(parsed.data.command) : false;
    },
    invoke: async (input, ctx) => {
      if (!ctx.backend?.exec) throw new Error("No execution backend is available for powershell.");
      const parsed = schema.parse(input);
      const resolvedCwd = await resolveWorkspacePath(ctx, ".");
      const workspaceRoot = getWorkspaceRoot(ctx);
      const readOnly = isReadOnlyPowerShell(parsed.command);
      const blockedSleep = detectBlockedSleepPattern(parsed.command);
      const policy = getPowerShellPolicy(ctx);

      for (const pattern of policy?.denyPatterns ?? []) {
        if (parsed.command.toLowerCase().includes(pattern.toLowerCase())) {
          throw new Error(`PowerShell policy denied command by pattern "${pattern}".`);
        }
      }

      if (blockedSleep && !parsed.run_in_background) {
        throw new Error(
          `Blocked foreground sleep command (${blockedSleep}). Run it in background or avoid the blocking wait.`,
        );
      }

      await validatePowerShellWorkspaceSafety(parsed.command, workspaceRoot, resolvedCwd.fullPath);

      if (parsed.run_in_background) {
        const taskId = `ps_${randomUUID().replaceAll("-", "")}`;
        const outputDir = join(workspaceRoot, ".renx-tool-results");
        const outputFile = join(outputDir, `${taskId}.log`);
        const startedAt = nowIso();
        const initialRecord = {
          id: taskId,
          command: parsed.command,
          cwd: resolvedCwd.fullPath,
          status: "running" as const,
          readOnly,
          outputFile,
          startedAt,
          ...(parsed.description ? { description: parsed.description } : {}),
        };
        const controller = registerBackgroundShellTask(
          ctx.runContext.state.runId,
          taskId,
          initialRecord,
        );

        const runningPatch = buildPlatformPatch(ctx, (state) => ({
          ...state,
          shellCommands: {
            ...state.shellCommands,
            [taskId]: {
              ...initialRecord,
            },
          },
        }));

        void (async () => {
          try {
            const backgroundResult = await ctx.backend!.exec!(parsed.command, {
              cwd: resolvedCwd.fullPath,
              timeoutMs: parsed.timeout ?? 30_000,
            });
            const combinedOutput = [
              backgroundResult.stdout,
              backgroundResult.stderr,
              `exit_code: ${backgroundResult.exitCode}`,
            ]
              .filter((part) => part.length > 0)
              .join("\n\n");
            await mkdir(outputDir, { recursive: true });
            await writeFile(outputFile, combinedOutput, "utf8");
            controller.update((state) => ({
              ...state,
              status: backgroundResult.exitCode === 0 ? "completed" : "failed",
              outputFile,
              exitCode: backgroundResult.exitCode,
              finishedAt: nowIso(),
            }));
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            await mkdir(outputDir, { recursive: true });
            await writeFile(outputFile, errorMessage, "utf8");
            controller.update((state) => ({
              ...state,
              status: "failed",
              outputFile,
              error: errorMessage,
              finishedAt: nowIso(),
            }));
          }
        })();

        return {
          content: `PowerShell command launched in background with task ID ${taskId}. Output file: ${outputFile}`,
          structured: {
            status: "async_launched",
            taskId,
            outputFile,
            cwd: resolvedCwd.fullPath,
            readOnly,
            ...(parsed.description ? { description: parsed.description } : {}),
          },
          statePatch: runningPatch,
        };
      }

      const result = await ctx.backend.exec(parsed.command, {
        cwd: resolvedCwd.fullPath,
        timeoutMs: parsed.timeout ?? 30_000,
      });
      const image = detectImageFromStdout(result.stdout);
      if (image) {
        const binaryArtifact = writeBinaryArtifact(
          Buffer.from(result.stdout, "latin1"),
          image.ext,
          {
            filePrefix: "powershell",
            resultsDir: `${workspaceRoot}\\.renx-tool-results`,
          },
        );
        return {
          content: `Binary image output detected (${image.mime}, ${image.byteLength} bytes). Saved to ${binaryArtifact.path}`,
          structured: {
            ...result,
            cwd: resolvedCwd.fullPath,
            readOnly,
            isImage: true,
            image,
            truncated: false,
            totalChars: result.stdout.length + result.stderr.length,
            persistedOutputPath: binaryArtifact.path,
            persistedOutputSize: binaryArtifact.bytesWritten,
            ...(parsed.description ? { description: parsed.description } : {}),
          },
        };
      }
      const combinedOutput = [result.stdout, result.stderr, `exit_code: ${result.exitCode}`]
        .filter((part) => part.length > 0)
        .join("\n\n");
      const spilled = spillTextIfLarge(combinedOutput, {
        filePrefix: "powershell",
        resultsDir: `${workspaceRoot}\\.renx-tool-results`,
      });
      return {
        content: spilled.content,
        structured: {
          ...result,
          cwd: resolvedCwd.fullPath,
          readOnly,
          truncated: spilled.truncated,
          totalChars: spilled.totalChars,
          ...(spilled.artifactPath ? { persistedOutputPath: spilled.artifactPath } : {}),
          ...(parsed.description ? { description: parsed.description } : {}),
        },
      };
    },
  };
};

export const createSleepTool = (): AgentTool => {
  const schema = z.object({ durationMs: z.number().int().min(0).max(60_000) });
  return {
    name: "Sleep",
    description: SLEEP_TOOL_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["timing"],
      sandboxExpectation: "read-only",
      auditCategory: "utility",
    }),
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    invoke: async (input) => {
      const parsed = schema.parse(input);
      await delay(parsed.durationMs);
      return { content: `Slept for ${parsed.durationMs}ms.` };
    },
  };
};

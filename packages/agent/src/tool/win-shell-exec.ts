import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Options forwarded to Node `execFile` (cwd, env, timeout). */
export type WinShellExecFileOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
};

function windowsSystemRoot(): string {
  return process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
}

function uniquePaths(paths: (string | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** PowerShell candidates: bundled 5.x path first (works when PATH is stripped), then PATH, then pwsh 7. */
function windowsPowerShellExeCandidates(): string[] {
  const root = windowsSystemRoot();
  const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const pwsh7 = join(programFiles, "PowerShell", "7", "pwsh.exe");
  return uniquePaths([
    join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "powershell.exe",
    pwsh7,
    "pwsh.exe",
  ]);
}

/** cmd.exe candidates when PowerShell cannot be spawned. */
function windowsCmdExeCandidates(): string[] {
  const root = windowsSystemRoot();
  return uniquePaths([join(root, "System32", "cmd.exe"), process.env.ComSpec, "cmd.exe"]);
}

async function execOrNullOnEnoent(
  file: string,
  args: string[],
  opts: WinShellExecFileOptions,
): Promise<{ stdout: string; stderr: string } | null> {
  try {
    return await execFileAsync(file, args, opts);
  } catch (err) {
    if ((err as { code?: string | number }).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * On Windows, runs `command` via PowerShell when possible, then falls back to `cmd.exe /d /s /c`.
 *
 * Uses **absolute paths** under `%SystemRoot%\System32\…` first so execution still works when
 * `PATH` is empty (CI, embedded hosts, some sandboxes) — this is different from a permission
 * denial; `ENOENT` / exit **127** in {@link LocalBackend} usually means the shell binary could
 * not be located or spawned.
 */
export async function execWindowsPreferPowerShell(
  command: string,
  opts: WinShellExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  const psArgs = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ];

  for (const exe of windowsPowerShellExeCandidates()) {
    const r = await execOrNullOnEnoent(exe, psArgs, opts);
    if (r) {
      return r;
    }
  }

  const cmdArgs = ["/d", "/s", "/c", command];
  for (const exe of windowsCmdExeCandidates()) {
    const r = await execOrNullOnEnoent(exe, cmdArgs, opts);
    if (r) {
      return r;
    }
  }

  const err = new Error(
    "Could not spawn PowerShell or cmd.exe (ENOENT). Typical causes: missing SystemRoot, empty PATH with no System32 access, or the host blocks child processes — not a shell command permission on a specific folder.",
  ) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  throw err;
}

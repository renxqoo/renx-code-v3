import { execFile } from "node:child_process";
import { platform } from "node:process";
import { promisify } from "node:util";

import type {
  BackendCapabilities,
  ExecOptions,
  ExecResult,
  ExecutionBackend,
  FileInfo,
} from "./types";
import { execWindowsPreferPowerShell, type WinShellExecFileOptions } from "./win-shell-exec";

const execFileAsync = promisify(execFile);

function buildChildExecOpts(opts?: ExecOptions): WinShellExecFileOptions {
  const o: WinShellExecFileOptions = { env: { ...process.env, ...opts?.env } };
  if (opts?.cwd !== undefined) {
    o.cwd = opts.cwd;
  }
  if (opts?.timeoutMs !== undefined) {
    o.timeout = opts.timeoutMs;
  }
  return o;
}

/**
 * Local execution backend — runs commands and accesses filesystem
 * directly on the host machine.
 */
export class LocalBackend implements ExecutionBackend {
  readonly kind = "local";

  capabilities(): BackendCapabilities {
    return {
      exec: true,
      filesystemRead: true,
      filesystemWrite: true,
      network: true,
    };
  }

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    const execOpts = buildChildExecOpts(opts);
    try {
      const { stdout, stderr } =
        platform === "win32"
          ? await execWindowsPreferPowerShell(command, execOpts)
          : await execFileAsync("sh", ["-lc", command], execOpts);
      return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: string | number };
      let exitCode = 1;
      console.log(e);
      if (e.code === "ENOENT") {
        exitCode = 127;
      } else if (typeof e.code === "number" && Number.isFinite(e.code)) {
        // Node reports the child process exit code here (e.g. 127 from sh, 9009 from cmd).
        exitCode = e.code;
      }
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? String(err),
        exitCode,
      };
    }
  }

  async readFile(path: string): Promise<string> {
    const fs = await import("node:fs/promises");
    return fs.readFile(path, "utf-8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    const fs = await import("node:fs/promises");
    await fs.writeFile(path, content, "utf-8");
  }

  async listFiles(path: string): Promise<FileInfo[]> {
    const fs = await import("node:fs/promises");
    const entries = await fs.readdir(path, { withFileTypes: true });
    return Promise.all(
      entries.map(async (entry) => {
        const fullPath = `${path}/${entry.name}`;
        const stat = entry.isSymbolicLink() ? await fs.stat(fullPath) : await fs.lstat(fullPath);
        return {
          path: fullPath,
          isDirectory: stat.isDirectory(),
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        };
      }),
    );
  }
}

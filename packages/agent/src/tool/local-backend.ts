import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  BackendCapabilities,
  ExecOptions,
  ExecResult,
  ExecutionBackend,
  FileInfo,
} from "./types";

const execFileAsync = promisify(execFile);

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
    try {
      const { stdout, stderr } = await execFileAsync("sh", ["-lc", command], {
        cwd: opts?.cwd,
        env: { ...process.env, ...opts?.env },
        timeout: opts?.timeoutMs,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: string };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? String(err),
        exitCode: e.code === "ENOENT" ? 127 : 1,
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

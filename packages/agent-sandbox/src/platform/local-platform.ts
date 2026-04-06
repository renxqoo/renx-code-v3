import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { platform as currentPlatform } from "node:process";
import { promisify } from "node:util";

import type {
  BackendCapabilities,
  BackendSession,
  CreateSessionOptions,
  ExecResult,
  FileInfo,
} from "@renx/agent";
import { execWindowsPreferPowerShell } from "@renx/agent";

import { SandboxPlatformError } from "../errors";
import {
  createSandboxId,
  isPathWithin,
  normalizeComparablePath,
  stripWrappingQuotes,
} from "../path-utils";
import type {
  SandboxExecRequest,
  SandboxInstance,
  SandboxLease,
  SandboxPlatform,
  SandboxSnapshotRecord,
} from "../types";

const execFileAsync = promisify(execFile);

const DEFAULT_LOCAL_SANDBOX_ENV_KEYS =
  currentPlatform === "win32"
    ? ["PATH", "PATHEXT", "ComSpec", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "HOME"]
    : ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "SHELL"];

const createLocalSandboxCapabilities = (): BackendCapabilities => ({
  exec: true,
  filesystemRead: true,
  filesystemWrite: true,
  network: true,
  persistentSession: true,
  binaryRead: true,
  pathMetadata: true,
  snapshots: true,
});

const sha256 = (content: Uint8Array): string => createHash("sha256").update(content).digest("hex");

const normalizeForSnapshot = (value: string): string => normalize(value).replaceAll("\\", "/");

const isPathInside = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && rel !== ".." && !isAbsolute(rel));
};

const createLocalSandboxProcessEnv = (
  env: Record<string, string> | undefined,
): Record<string, string> => {
  const baseEntries = DEFAULT_LOCAL_SANDBOX_ENV_KEYS.flatMap((key) => {
    const value = process.env[key];
    return value === undefined ? [] : [[key, value] as const];
  });
  return {
    ...Object.fromEntries(baseEntries),
    ...(env ?? {}),
  };
};

export class LocalSandboxPlatform implements SandboxPlatform {
  readonly kind = "local";

  async create(lease: SandboxLease): Promise<SandboxInstance> {
    const workspaceRoot = resolve(lease.workspaceRoot);
    const mountPath = lease.mountPath ? normalizeComparablePath(lease.mountPath) : undefined;
    const sessions = new Map<string, BackendSession>();
    await mkdir(workspaceRoot, { recursive: true });

    const translateMountedAbsolute = (input: string): string | undefined => {
      if (!mountPath) return undefined;
      const normalizedInput = normalizeComparablePath(input);
      if (!isPathWithin(mountPath, normalizedInput)) {
        return undefined;
      }
      const suffix = normalizedInput.slice(mountPath.length).replace(/^\/+/, "");
      return resolve(workspaceRoot, suffix);
    };

    const resolvePathInWorkspace = (input: string, baseDir = workspaceRoot): string => {
      const translated = translateMountedAbsolute(input);
      const candidate = translated
        ? resolve(translated)
        : isAbsolute(input)
          ? resolve(input)
          : resolve(baseDir, input);
      if (!isPathInside(workspaceRoot, candidate)) {
        throw new SandboxPlatformError(`Path is outside the sandbox workspace: ${input}`);
      }
      return candidate;
    };

    const resolveSession = (sessionId: string | undefined): BackendSession | undefined => {
      if (!sessionId) return undefined;
      const session = sessions.get(sessionId);
      if (!session) {
        throw new SandboxPlatformError(`Sandbox session not found: ${sessionId}`);
      }
      return session;
    };

    const getWorkingDirectory = (request: SandboxExecRequest): string => {
      const session = resolveSession(request.sessionId);
      const base = session?.cwd ?? workspaceRoot;
      return request.cwd ? resolvePathInWorkspace(request.cwd, base) : base;
    };

    const executeLocalShell = async (
      command: string,
      request: SandboxExecRequest,
      cwd: string,
    ): Promise<ExecResult> => {
      const startedAt = Date.now();
      try {
        const child =
          currentPlatform === "win32"
            ? await execWindowsPreferPowerShell(command, {
                cwd,
                env: createLocalSandboxProcessEnv(request.env),
                ...(request.timeoutMs !== undefined ? { timeout: request.timeoutMs } : {}),
              })
            : await execFileAsync("sh", ["-lc", command], {
                cwd,
                env: createLocalSandboxProcessEnv(request.env),
                ...(request.timeoutMs !== undefined ? { timeout: request.timeoutMs } : {}),
              });
        return {
          stdout: child.stdout,
          stderr: child.stderr,
          exitCode: 0,
          durationMs: Date.now() - startedAt,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        };
      } catch (error) {
        const execError = error as { stdout?: string; stderr?: string; code?: string | number };
        const exitCode =
          execError.code === "ENOENT"
            ? 127
            : typeof execError.code === "number" && Number.isFinite(execError.code)
              ? execError.code
              : 1;
        return {
          stdout: execError.stdout ?? "",
          stderr: execError.stderr ?? String(error),
          exitCode,
          durationMs: Date.now() - startedAt,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        };
      }
    };

    const collectFiles = async (root: string): Promise<string[]> => {
      const entries = await readdir(root, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const fullPath = resolve(root, entry.name);
        if (entry.isDirectory()) {
          files.push(...(await collectFiles(fullPath)));
          continue;
        }
        if (entry.isFile()) {
          files.push(fullPath);
        }
      }
      return files;
    };

    return {
      id: lease.leaseId,
      platform: this.kind,
      workspaceRoot,
      capabilities: () => createLocalSandboxCapabilities(),
      exec: async (request: SandboxExecRequest) => {
        const startedAt = Date.now();
        const cwd = getWorkingDirectory(request);
        const command = request.command.trim();

        if (command.length === 0) {
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
            durationMs: Date.now() - startedAt,
            ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          };
        }

        if (command === "pwd") {
          return {
            stdout: cwd,
            stderr: "",
            exitCode: 0,
            durationMs: Date.now() - startedAt,
            ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          };
        }

        const changeDirectory = command.match(/^cd(?:\s+(.+))?$/i);
        if (changeDirectory) {
          const nextPath = resolvePathInWorkspace(
            stripWrappingQuotes(changeDirectory[1]?.trim() || workspaceRoot),
            cwd,
          );
          const session = resolveSession(request.sessionId);
          if (session) {
            sessions.set(session.id, { ...session, cwd: nextPath });
          }
          return {
            stdout: nextPath,
            stderr: "",
            exitCode: 0,
            durationMs: Date.now() - startedAt,
            ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          };
        }

        const cat = command.match(/^cat\s+(.+)$/i);
        if (cat) {
          const filePath = resolvePathInWorkspace(stripWrappingQuotes(cat[1]!.trim()), cwd);
          return {
            stdout: await readFile(filePath, "utf8"),
            stderr: "",
            exitCode: 0,
            durationMs: Date.now() - startedAt,
            ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          };
        }

        return await executeLocalShell(command, request, cwd);
      },
      readFile: async (path: string): Promise<string> => {
        const resolvedPath = resolvePathInWorkspace(path);
        return await readFile(resolvedPath, "utf8");
      },
      readBinaryFile: async (path: string): Promise<Uint8Array> => {
        const resolvedPath = resolvePathInWorkspace(path);
        return await readFile(resolvedPath);
      },
      writeFile: async (path: string, content: string): Promise<void> => {
        const resolvedPath = resolvePathInWorkspace(path);
        await mkdir(dirname(resolvedPath), { recursive: true });
        await writeFile(resolvedPath, content, "utf8");
      },
      listFiles: async (path: string): Promise<FileInfo[]> => {
        const resolvedPath = resolvePathInWorkspace(path);
        const info = await stat(resolvedPath);
        if (info.isFile()) {
          const payload = await readFile(resolvedPath);
          return [
            {
              path: resolvedPath,
              isDirectory: false,
              size: info.size,
              modifiedAt: info.mtime.toISOString(),
              sha256: sha256(payload),
            },
          ];
        }

        const entries = await readdir(resolvedPath, { withFileTypes: true });
        return Promise.all(
          entries.map(async (entry) => {
            const fullPath = resolve(resolvedPath, entry.name);
            const entryInfo = await stat(fullPath);
            if (entryInfo.isDirectory()) {
              return {
                path: fullPath,
                isDirectory: true,
                modifiedAt: entryInfo.mtime.toISOString(),
              };
            }
            const payload = await readFile(fullPath);
            return {
              path: fullPath,
              isDirectory: false,
              size: entryInfo.size,
              modifiedAt: entryInfo.mtime.toISOString(),
              sha256: sha256(payload),
            };
          }),
        );
      },
      statPath: async (path: string): Promise<FileInfo | undefined> => {
        try {
          const resolvedPath = resolvePathInWorkspace(path);
          const info = await stat(resolvedPath);
          if (info.isDirectory()) {
            return {
              path: resolvedPath,
              isDirectory: true,
              modifiedAt: info.mtime.toISOString(),
            };
          }
          const payload = await readFile(resolvedPath);
          return {
            path: resolvedPath,
            isDirectory: false,
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
            sha256: sha256(payload),
          };
        } catch {
          return undefined;
        }
      },
      createSession: async (options?: CreateSessionOptions): Promise<BackendSession> => {
        const session: BackendSession = {
          id: createSandboxId("sandbox_session"),
          cwd: resolvePathInWorkspace(options?.cwd ?? workspaceRoot),
          ...(options?.metadata ? { metadata: options.metadata } : {}),
        };
        sessions.set(session.id, session);
        return session;
      },
      closeSession: async (sessionId: string): Promise<void> => {
        sessions.delete(sessionId);
      },
      captureSnapshot: async (snapshotId: string): Promise<SandboxSnapshotRecord> => {
        const files = await collectFiles(workspaceRoot);
        return {
          snapshotId,
          platform: this.kind,
          createdAt: new Date().toISOString(),
          files: await Promise.all(
            files
              .sort((left, right) => left.localeCompare(right))
              .map(async (filePath) => {
                const payload = await readFile(filePath);
                const info = await stat(filePath);
                return {
                  path: normalizeForSnapshot(relative(workspaceRoot, filePath)),
                  base64: payload.toString("base64"),
                  modifiedAt: info.mtime.toISOString(),
                };
              }),
          ),
          metadata: {
            workspaceRoot,
            ...(lease.mountPath ? { mountPath: lease.mountPath } : {}),
          },
        };
      },
      restoreSnapshot: async (record: SandboxSnapshotRecord): Promise<void> => {
        const existingFiles = await collectFiles(workspaceRoot);
        const desiredFiles = new Set(record.files.map((file) => resolve(workspaceRoot, file.path)));

        for (const filePath of existingFiles) {
          if (!desiredFiles.has(filePath)) {
            await rm(filePath, { force: true });
          }
        }

        for (const file of record.files) {
          const resolvedPath = resolvePathInWorkspace(file.path);
          await mkdir(dirname(resolvedPath), { recursive: true });
          await writeFile(resolvedPath, Buffer.from(file.base64, "base64"));
        }
      },
      dispose: async (): Promise<void> => {
        sessions.clear();
      },
    };
  }
}

import type {
  BackendCapabilities,
  BackendSession,
  CreateSessionOptions,
  FileInfo,
} from "@renx/agent";

import { SandboxFileOperationError, SandboxPlatformError } from "../errors";
import {
  createSandboxId,
  isAbsoluteComparablePath,
  isPathWithin,
  joinComparablePath,
  normalizeComparablePath,
  stripWrappingQuotes,
} from "../path-utils";
import type {
  SandboxExecRequest,
  SandboxExecResult,
  SandboxFileDownloadResult,
  SandboxFileUploadResult,
  SandboxInstance,
  SandboxLease,
  SandboxPlatform,
  SandboxRuntimeConnection,
  SandboxSnapshotRecord,
} from "../types";

const DEFAULT_CONNECTION_CAPABILITIES: BackendCapabilities = {
  exec: true,
  filesystemRead: true,
  filesystemWrite: true,
  network: false,
  persistentSession: true,
  binaryRead: true,
  pathMetadata: true,
  snapshots: true,
};

const ensureSingleUpload = (path: string, result: SandboxFileUploadResult | undefined): void => {
  if (!result) {
    throw new SandboxFileOperationError(
      path,
      "invalid_path",
      `Sandbox upload returned no response for ${path}`,
    );
  }
  if (result.error) {
    throw new SandboxFileOperationError(path, result.error);
  }
};

const ensureSingleDownload = (
  path: string,
  result: SandboxFileDownloadResult | undefined,
): Uint8Array => {
  if (!result) {
    throw new SandboxFileOperationError(
      path,
      "invalid_path",
      `Sandbox download returned no response for ${path}`,
    );
  }
  if (result.error) {
    throw new SandboxFileOperationError(path, result.error);
  }
  if (!result.content) {
    throw new SandboxFileOperationError(path, "file_not_found");
  }
  return result.content;
};

export abstract class ConnectionSandboxPlatform implements SandboxPlatform {
  abstract readonly kind: string;

  protected capabilities(): BackendCapabilities {
    return DEFAULT_CONNECTION_CAPABILITIES;
  }

  protected abstract connect(lease: SandboxLease): Promise<SandboxRuntimeConnection>;

  async create(lease: SandboxLease): Promise<SandboxInstance> {
    const connection = await this.connect(lease);
    const workspaceRoot = normalizeComparablePath(lease.workspaceRoot);
    const mountPath = lease.mountPath ? normalizeComparablePath(lease.mountPath) : undefined;
    const sessions = new Map<string, BackendSession>();

    const translateMountedPath = (input: string): string | undefined => {
      if (!mountPath) return undefined;
      const normalizedInput = normalizeComparablePath(input);
      if (!isPathWithin(mountPath, normalizedInput)) {
        return undefined;
      }
      const suffix = normalizedInput.slice(mountPath.length).replace(/^\/+/, "");
      return joinComparablePath(workspaceRoot, suffix);
    };

    const resolvePath = (input: string, baseDir = workspaceRoot): string => {
      const translated = translateMountedPath(input);
      const candidate = translated
        ? translated
        : isAbsoluteComparablePath(input)
          ? normalizeComparablePath(input)
          : joinComparablePath(baseDir, input);
      if (!isPathWithin(workspaceRoot, candidate)) {
        throw new SandboxPlatformError(`Path is outside the sandbox workspace: ${input}`);
      }
      return candidate;
    };

    const normalizeInfo = (info: FileInfo): FileInfo => {
      const normalizedPath = normalizeComparablePath(info.path);
      if (!isPathWithin(workspaceRoot, normalizedPath)) {
        throw new SandboxPlatformError(
          `Sandbox runtime returned a path outside the workspace: ${info.path}`,
        );
      }
      return {
        ...info,
        path: normalizedPath,
      };
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
      return request.cwd ? resolvePath(request.cwd, base) : base;
    };

    const collectFilesRecursively = async (path: string): Promise<FileInfo[]> => {
      const discovered: FileInfo[] = [];
      const pending = [path];

      while (pending.length > 0) {
        const current = pending.pop()!;
        const entries = (await connection.listFiles(current)).map(normalizeInfo);
        for (const entry of entries) {
          if (entry.isDirectory) {
            pending.push(entry.path);
            continue;
          }
          discovered.push(entry);
        }
      }

      return discovered.sort((left, right) => left.path.localeCompare(right.path));
    };

    return {
      id: lease.leaseId,
      platform: this.kind,
      workspaceRoot,
      capabilities: () => this.capabilities(),
      exec: async (request: SandboxExecRequest): Promise<SandboxExecResult> => {
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
          const nextPath = resolvePath(
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

        const result = await connection.execute({
          command,
          cwd,
          ...(request.env ? { env: request.env } : {}),
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
          ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
          ...(request.metadata ? { metadata: request.metadata } : {}),
        });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        };
      },
      readFile: async (path: string): Promise<string> => {
        const resolvedPath = resolvePath(path);
        const content = ensureSingleDownload(
          resolvedPath,
          (await connection.downloadFiles([resolvedPath]))[0],
        );
        return Buffer.from(content).toString("utf8");
      },
      readBinaryFile: async (path: string): Promise<Uint8Array> => {
        const resolvedPath = resolvePath(path);
        return ensureSingleDownload(
          resolvedPath,
          (await connection.downloadFiles([resolvedPath]))[0],
        );
      },
      writeFile: async (path: string, content: string): Promise<void> => {
        const resolvedPath = resolvePath(path);
        ensureSingleUpload(
          resolvedPath,
          (
            await connection.uploadFiles([
              { path: resolvedPath, content: Uint8Array.from(Buffer.from(content, "utf8")) },
            ])
          )[0],
        );
      },
      listFiles: async (path: string): Promise<FileInfo[]> => {
        const resolvedPath = resolvePath(path);
        return (await connection.listFiles(resolvedPath)).map(normalizeInfo);
      },
      statPath: async (path: string): Promise<FileInfo | undefined> => {
        const resolvedPath = resolvePath(path);
        const entry = await connection.statPath(resolvedPath);
        return entry ? normalizeInfo(entry) : undefined;
      },
      createSession: async (options?: CreateSessionOptions): Promise<BackendSession> => {
        const session: BackendSession = {
          id: createSandboxId("sandbox_session"),
          cwd: resolvePath(options?.cwd ?? workspaceRoot),
          ...(options?.metadata ? { metadata: options.metadata } : {}),
        };
        sessions.set(session.id, session);
        return session;
      },
      closeSession: async (sessionId: string): Promise<void> => {
        sessions.delete(sessionId);
      },
      captureSnapshot: async (snapshotId: string): Promise<SandboxSnapshotRecord> => {
        const files = await collectFilesRecursively(workspaceRoot);
        const downloadResults = await connection.downloadFiles(files.map((file) => file.path));
        return {
          snapshotId,
          platform: this.kind,
          createdAt: new Date().toISOString(),
          files: files.map((file, index) => ({
            path: file.path.slice(workspaceRoot.length).replace(/^\/+/, ""),
            base64: Buffer.from(ensureSingleDownload(file.path, downloadResults[index])).toString(
              "base64",
            ),
            ...(file.modifiedAt ? { modifiedAt: file.modifiedAt } : {}),
          })),
          metadata: {
            workspaceRoot,
            ...(lease.mountPath ? { mountPath: lease.mountPath } : {}),
            connectionId: connection.id,
          },
        };
      },
      restoreSnapshot: async (record: SandboxSnapshotRecord): Promise<void> => {
        const currentFiles = await collectFilesRecursively(workspaceRoot);
        const desiredPaths = new Set(record.files.map((file) => resolvePath(file.path)));
        const extraPaths = currentFiles
          .map((file) => file.path)
          .filter((filePath) => !desiredPaths.has(filePath));

        if (extraPaths.length > 0) {
          await connection.deletePaths(extraPaths);
        }

        const uploads = await connection.uploadFiles(
          record.files.map((file) => ({
            path: resolvePath(file.path),
            content: Uint8Array.from(Buffer.from(file.base64, "base64")),
          })),
        );
        uploads.forEach((result, index) => {
          ensureSingleUpload(resolvePath(record.files[index]!.path), result);
        });
      },
      dispose: async (): Promise<void> => {
        sessions.clear();
        await connection.dispose?.();
      },
    };
  }
}

import { createHash } from "node:crypto";
import { posix } from "node:path";

import type {
  BackendCapabilities,
  BackendSession,
  CreateSessionOptions,
  FileInfo,
} from "@renx/agent";

import { SandboxPlatformError } from "../errors";
import { createSandboxId, stripWrappingQuotes } from "../path-utils";
import type {
  SandboxExecRequest,
  SandboxExecResult,
  SandboxInstance,
  SandboxLease,
  SandboxPlatform,
  SandboxSnapshotRecord,
} from "../types";

interface InMemoryFileRecord {
  content: Uint8Array;
  modifiedAt: string;
}

export interface InMemorySandboxState {
  files: Map<string, InMemoryFileRecord>;
  sessions: Map<string, BackendSession>;
}

export const createInMemoryCapabilities = (): BackendCapabilities => ({
  exec: true,
  filesystemRead: true,
  filesystemWrite: true,
  network: false,
  persistentSession: true,
  binaryRead: true,
  pathMetadata: true,
  snapshots: true,
});

export type InMemorySandboxInstance = SandboxInstance & {
  exec(request: SandboxExecRequest): Promise<SandboxExecResult>;
  readFile(path: string): Promise<string>;
  readBinaryFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(path: string): Promise<FileInfo[]>;
  statPath(path: string): Promise<FileInfo | undefined>;
  createSession(options?: CreateSessionOptions): Promise<BackendSession>;
  closeSession(sessionId: string): Promise<void>;
  captureSnapshot(snapshotId: string): Promise<SandboxSnapshotRecord>;
  restoreSnapshot(record: SandboxSnapshotRecord): Promise<void>;
  dispose(): Promise<void>;
};

const sha256 = (content: Uint8Array): string => createHash("sha256").update(content).digest("hex");

const asText = (content: Uint8Array): string => Buffer.from(content).toString("utf8");

export class InMemorySandboxPlatform implements SandboxPlatform {
  readonly kind = "memory";

  async create(lease: SandboxLease): Promise<SandboxInstance> {
    const workspaceRoot = posix.resolve(lease.workspaceRoot);
    const state: InMemorySandboxState = {
      files: new Map<string, InMemoryFileRecord>(),
      sessions: new Map<string, BackendSession>(),
    };

    const isWithinWorkspace = (target: string): boolean => {
      const relativePath = posix.relative(workspaceRoot, target);
      return relativePath === "" || (!relativePath.startsWith("../") && relativePath !== "..");
    };

    const resolvePath = (input: string, baseDir = workspaceRoot): string => {
      const candidate = posix.isAbsolute(input)
        ? posix.resolve(input)
        : posix.resolve(baseDir, input);
      if (!isWithinWorkspace(candidate)) {
        throw new SandboxPlatformError(`Path is outside the sandbox workspace: ${input}`);
      }
      return candidate;
    };

    const resolveSession = (sessionId: string | undefined): BackendSession | undefined => {
      if (!sessionId) return undefined;
      const session = state.sessions.get(sessionId);
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

    const createDirectoryInfo = (path: string): FileInfo => ({
      path,
      isDirectory: true,
    });

    const createFileInfo = (path: string, record: InMemoryFileRecord): FileInfo => ({
      path,
      isDirectory: false,
      size: record.content.byteLength,
      modifiedAt: record.modifiedAt,
      sha256: sha256(record.content),
    });

    return {
      id: lease.leaseId,
      platform: this.kind,
      workspaceRoot,
      capabilities: () => createInMemoryCapabilities(),
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
            state.sessions.set(session.id, { ...session, cwd: nextPath });
          }
          return {
            stdout: nextPath,
            stderr: "",
            exitCode: 0,
            durationMs: Date.now() - startedAt,
            ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          };
        }

        const echo = command.match(/^echo\s+([\s\S]+)$/i);
        if (echo) {
          return {
            stdout: stripWrappingQuotes(echo[1]!.trim()),
            stderr: "",
            exitCode: 0,
            durationMs: Date.now() - startedAt,
            ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          };
        }

        const cat = command.match(/^cat\s+(.+)$/i);
        if (cat) {
          const target = resolvePath(stripWrappingQuotes(cat[1]!.trim()), cwd);
          const file = state.files.get(target);
          if (!file) {
            return {
              stdout: "",
              stderr: `File not found: ${target}`,
              exitCode: 1,
              durationMs: Date.now() - startedAt,
              ...(request.sessionId ? { sessionId: request.sessionId } : {}),
            };
          }
          return {
            stdout: asText(file.content),
            stderr: "",
            exitCode: 0,
            durationMs: Date.now() - startedAt,
            ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          };
        }

        return {
          stdout: "",
          stderr: `Unsupported in-memory sandbox command: ${command}`,
          exitCode: 127,
          durationMs: Date.now() - startedAt,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        };
      },
      readFile: async (path: string): Promise<string> => {
        const record = state.files.get(resolvePath(path));
        if (!record) {
          throw new SandboxPlatformError(`File not found: ${path}`);
        }
        return asText(record.content);
      },
      readBinaryFile: async (path: string): Promise<Uint8Array> => {
        const record = state.files.get(resolvePath(path));
        if (!record) {
          throw new SandboxPlatformError(`File not found: ${path}`);
        }
        return Uint8Array.from(record.content);
      },
      writeFile: async (path: string, content: string): Promise<void> => {
        const resolvedPath = resolvePath(path);
        state.files.set(resolvedPath, {
          content: Uint8Array.from(Buffer.from(content, "utf8")),
          modifiedAt: new Date().toISOString(),
        });
      },
      listFiles: async (path: string): Promise<FileInfo[]> => {
        const directory = resolvePath(path);
        const children = new Map<string, FileInfo>();

        for (const [filePath, record] of state.files.entries()) {
          if (filePath === directory) {
            return [createFileInfo(filePath, record)];
          }
          if (!filePath.startsWith(`${directory}/`)) {
            continue;
          }
          const remainder = filePath.slice(directory.length + 1);
          if (remainder.length === 0) continue;
          const nextSegment = remainder.split("/")[0]!;
          const childPath = posix.join(directory, nextSegment);
          if (remainder.includes("/")) {
            children.set(childPath, createDirectoryInfo(childPath));
            continue;
          }
          children.set(childPath, createFileInfo(childPath, record));
        }

        if (children.size === 0 && directory !== workspaceRoot) {
          throw new SandboxPlatformError(`Directory not found: ${path}`);
        }

        return [...children.values()].sort((left, right) => left.path.localeCompare(right.path));
      },
      statPath: async (path: string): Promise<FileInfo | undefined> => {
        const resolvedPath = resolvePath(path);
        const file = state.files.get(resolvedPath);
        if (file) {
          return createFileInfo(resolvedPath, file);
        }
        if (resolvedPath === workspaceRoot) {
          return createDirectoryInfo(resolvedPath);
        }
        for (const filePath of state.files.keys()) {
          if (filePath.startsWith(`${resolvedPath}/`)) {
            return createDirectoryInfo(resolvedPath);
          }
        }
        return undefined;
      },
      createSession: async (options?: CreateSessionOptions): Promise<BackendSession> => {
        const session: BackendSession = {
          id: createSandboxId("sandbox_session"),
          cwd: resolvePath(options?.cwd ?? workspaceRoot),
          ...(options?.metadata ? { metadata: options.metadata } : {}),
        };
        state.sessions.set(session.id, session);
        return session;
      },
      closeSession: async (sessionId: string): Promise<void> => {
        state.sessions.delete(sessionId);
      },
      captureSnapshot: async (snapshotId: string): Promise<SandboxSnapshotRecord> => ({
        snapshotId,
        platform: this.kind,
        createdAt: new Date().toISOString(),
        files: [...state.files.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([filePath, record]) => ({
            path: posix.relative(workspaceRoot, filePath),
            base64: Buffer.from(record.content).toString("base64"),
            modifiedAt: record.modifiedAt,
          })),
        metadata: {
          workspaceRoot,
        },
      }),
      restoreSnapshot: async (record: SandboxSnapshotRecord): Promise<void> => {
        state.files.clear();
        for (const file of record.files) {
          const resolvedPath = resolvePath(file.path);
          state.files.set(resolvedPath, {
            content: Uint8Array.from(Buffer.from(file.base64, "base64")),
            modifiedAt: file.modifiedAt ?? new Date().toISOString(),
          });
        }
      },
      dispose: async (): Promise<void> => {
        state.files.clear();
        state.sessions.clear();
      },
    };
  }
}

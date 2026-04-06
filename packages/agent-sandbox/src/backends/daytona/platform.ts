import type { FileInfo } from "@renx/agent";

import { SandboxPlatformError } from "../../errors";
import { createSandboxId, normalizeComparablePath } from "../../path-utils";
import type { SandboxLease, SandboxRuntimeConnection } from "../../types";
import { ConnectionSandboxPlatform } from "../../platform/connection-platform";
import { resolveDaytonaSandboxReference } from "../shared/lease-metadata";
import { buildPosixShellInvocation } from "../shared/shell-command";
import { DaytonaSandboxClient } from "./client";
import type {
  DaytonaSandboxClientLike,
  DaytonaSandboxFileInfo,
  DaytonaSandboxHandle,
  DaytonaSandboxPlatformOptions,
} from "./types";

const DEFAULT_PLATFORM = "daytona";

export class DaytonaSandboxPlatform extends ConnectionSandboxPlatform {
  readonly kind: string;

  private readonly client: DaytonaSandboxClientLike;

  constructor(options: DaytonaSandboxPlatformOptions = {}) {
    super();
    this.kind = options.kind ?? DEFAULT_PLATFORM;
    this.client =
      options.client ??
      new DaytonaSandboxClient({
        ...(options.config ? { config: options.config } : {}),
      });
  }

  protected async connect(lease: SandboxLease): Promise<SandboxRuntimeConnection> {
    const sandbox = await this.findSandbox(resolveDaytonaSandboxReference(lease));
    if (!sandbox) {
      throw new SandboxPlatformError(
        `Daytona sandbox lease ${lease.leaseId} could not resolve a sandbox handle.`,
      );
    }

    return {
      id: `daytona:${sandbox.id}`,
      execute: async (request) => {
        const sessionId = createSandboxId("daytona_session");
        const startedAt = Date.now();
        await sandbox.process.createSession(sessionId);
        try {
          const result = await sandbox.process.executeSessionCommand(
            sessionId,
            {
              command: buildPosixShellInvocation(request.command, {
                ...(request.cwd ? { cwd: request.cwd } : {}),
                ...(request.env ? { env: request.env } : {}),
                ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
              }),
              suppressInputEcho: true,
            },
            toSeconds(request.timeoutMs),
          );
          return {
            stdout: result.stdout ?? result.output ?? "",
            stderr: result.stderr ?? "",
            exitCode: result.exitCode ?? 0,
            durationMs: Date.now() - startedAt,
          };
        } finally {
          await sandbox.process.deleteSession(sessionId).catch(() => undefined);
        }
      },
      uploadFiles: async (files) =>
        await Promise.all(
          files.map(async (file) => {
            await sandbox.fs.uploadFile(Buffer.from(file.content), file.path);
            return {
              path: file.path,
            };
          }),
        ),
      downloadFiles: async (paths) =>
        await Promise.all(
          paths.map(async (path) => {
            try {
              return {
                path,
                content: Uint8Array.from(await sandbox.fs.downloadFile(path)),
              };
            } catch {
              return {
                path,
                error: "file_not_found",
              };
            }
          }),
        ),
      listFiles: async (path) =>
        (await sandbox.fs.listFiles(path)).map((entry) => mapDaytonaFileInfo(path, entry)),
      statPath: async (path) => {
        try {
          return mapDaytonaStatInfo(path, await sandbox.fs.getFileDetails(path));
        } catch {
          return undefined;
        }
      },
      deletePaths: async (paths) => {
        await Promise.all(
          paths.map(async (path) => {
            await sandbox.fs.deleteFile(path, false).catch(() => undefined);
          }),
        );
      },
      dispose: async () => {},
    };
  }

  private async findSandbox(reference: {
    sandboxId?: string;
    sandboxName?: string;
  }): Promise<DaytonaSandboxHandle | undefined> {
    if (reference.sandboxId) {
      const sandbox = await this.client.getSandbox(reference.sandboxId);
      if (sandbox) {
        return sandbox;
      }
    }

    if (reference.sandboxName) {
      return await this.client.getSandbox(reference.sandboxName);
    }

    return undefined;
  }
}

const mapDaytonaFileInfo = (directoryPath: string, entry: DaytonaSandboxFileInfo): FileInfo => {
  const basePath = normalizeComparablePath(directoryPath);
  const path = normalizeComparablePath(`${basePath}/${entry.name}`);
  return {
    path,
    isDirectory: entry.isDir,
    ...(entry.isDir ? {} : { size: entry.size }),
    ...(entry.modTime ? { modifiedAt: entry.modTime } : {}),
  };
};

const mapDaytonaStatInfo = (path: string, entry: DaytonaSandboxFileInfo): FileInfo => ({
  path: normalizeComparablePath(path),
  isDirectory: entry.isDir,
  ...(entry.isDir ? {} : { size: entry.size }),
  ...(entry.modTime ? { modifiedAt: entry.modTime } : {}),
});

const toSeconds = (timeoutMs: number | undefined): number | undefined =>
  timeoutMs && timeoutMs > 0 ? Math.max(1, Math.ceil(timeoutMs / 1000)) : undefined;

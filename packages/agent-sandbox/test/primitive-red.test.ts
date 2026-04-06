import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  ConnectionSandboxPlatform,
  SandboxFileOperationError,
  type SandboxFileDownloadResult,
  type SandboxFileUploadResult,
  type SandboxRuntimeConnection,
  type SandboxRuntimeExecuteRequest,
  type SandboxRuntimeExecuteResult,
} from "@renx/agent-sandbox";
import type { FileInfo } from "@renx/agent";
import { LocalBackend } from "@renx/agent";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class LocalRuntimeConnection implements SandboxRuntimeConnection {
  readonly id = "runtime-local";

  constructor(private readonly backend: LocalBackend) {}

  async execute(request: SandboxRuntimeExecuteRequest): Promise<SandboxRuntimeExecuteResult> {
    return await this.backend.exec!(request.command, {
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.env ? { env: request.env } : {}),
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    });
  }

  async uploadFiles(
    files: Array<{ path: string; content: Uint8Array }>,
  ): Promise<SandboxFileUploadResult[]> {
    return await Promise.all(
      files.map(async (file) => {
        await mkdir(dirname(file.path), { recursive: true }).catch(() => undefined);
        await writeFile(file.path, Buffer.from(file.content));
        return { path: file.path };
      }),
    );
  }

  async downloadFiles(paths: string[]): Promise<SandboxFileDownloadResult[]> {
    return await Promise.all(
      paths.map(async (path) => {
        try {
          return { path, content: await readFile(path) };
        } catch {
          return { path, error: "file_not_found" };
        }
      }),
    );
  }

  async listFiles(path: string): Promise<FileInfo[]> {
    try {
      const info = await stat(path);
      if (info.isFile()) {
        return [
          {
            path,
            isDirectory: false,
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
          },
        ];
      }
      const names = await readdir(path);
      return await Promise.all(
        names.map(async (name) => {
          const childPath = join(path, name);
          const childInfo = await stat(childPath);
          return childInfo.isDirectory()
            ? {
                path: childPath,
                isDirectory: true,
                modifiedAt: childInfo.mtime.toISOString(),
              }
            : {
                path: childPath,
                isDirectory: false,
                size: childInfo.size,
                modifiedAt: childInfo.mtime.toISOString(),
              };
        }),
      );
    } catch {
      return [];
    }
  }

  async statPath(path: string): Promise<FileInfo | undefined> {
    try {
      const info = await stat(path);
      return info.isDirectory()
        ? {
            path,
            isDirectory: true,
            modifiedAt: info.mtime.toISOString(),
          }
        : {
            path,
            isDirectory: false,
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
          };
    } catch {
      return undefined;
    }
  }

  async deletePaths(paths: string[]): Promise<void> {
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  }
}

class TestRuntimePlatform extends ConnectionSandboxPlatform {
  readonly kind = "runtime-test";

  protected async connect(): Promise<SandboxRuntimeConnection> {
    return new LocalRuntimeConnection(new LocalBackend());
  }
}

describe("connection sandbox platform", () => {
  it("derives file operations, sessions, and snapshots from runtime execution and file primitives", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-sandbox-primitive-"));
    tempDirs.push(dir);

    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "app.ts"), "export const value = 1;\n", "utf8");

    const platform = new TestRuntimePlatform();
    const instance = await platform.create({
      leaseId: "lease_primitive",
      platform: "runtime-test",
      workspaceRoot: dir,
    });

    const session = await instance.createSession({ cwd: dir });
    await instance.exec({ command: "cd src", sessionId: session.id });
    expect(
      (await instance.exec({ command: "pwd", sessionId: session.id })).stdout.trim(),
    ).toContain("src");

    expect(await instance.readFile(join(dir, "src", "app.ts"))).toContain("value = 1");
    await instance.writeFile(join(dir, "src", "app.ts"), "export const value = 2;\n");
    expect(await instance.readFile(join(dir, "src", "app.ts"))).toContain("value = 2");

    const info = await instance.statPath(join(dir, "src", "app.ts"));
    expect(info).toMatchObject({
      isDirectory: false,
      size: Buffer.byteLength("export const value = 2;\n", "utf8"),
    });

    const list = await instance.listFiles(join(dir, "src"));
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          isDirectory: false,
        }),
      ]),
    );

    const snapshot = await instance.captureSnapshot("primitive_snapshot");
    await instance.writeFile(join(dir, "src", "app.ts"), "export const value = 3;\n");
    await instance.restoreSnapshot(snapshot);
    expect(await instance.readFile(join(dir, "src", "app.ts"))).toContain("value = 2");
  });

  it("surfaces standardized file errors from runtime downloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-sandbox-primitive-missing-"));
    tempDirs.push(dir);

    const platform = new TestRuntimePlatform();
    const instance = await platform.create({
      leaseId: "lease_primitive_missing",
      platform: "runtime-test",
      workspaceRoot: dir,
    });

    await expect(instance.readFile(join(dir, "missing.txt"))).rejects.toBeInstanceOf(
      SandboxFileOperationError,
    );
  });
});

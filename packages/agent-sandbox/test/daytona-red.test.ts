import { describe, expect, it } from "vitest";

import type { FileInfo } from "@renx/agent";
import { DaytonaSandboxPlatform, DaytonaSandboxProvider } from "@renx/agent-sandbox";
import type {
  DaytonaSandboxClientLike,
  DaytonaSandboxCreateRequest,
  DaytonaSandboxFileSystemHandle,
  DaytonaSandboxHandle,
  DaytonaSandboxProcessHandle,
  DaytonaSandboxVolumeHandle,
} from "@renx/agent-sandbox";

const asBytes = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "utf8"));

class FakeDaytonaProcess implements DaytonaSandboxProcessHandle {
  readonly commands: string[] = [];

  async createSession(_sessionId: string): Promise<void> {}

  async executeSessionCommand(
    _sessionId: string,
    request: { command: string },
    _timeoutSec?: number,
  ): Promise<{ stdout?: string; stderr?: string; exitCode?: number; cmdId: string }> {
    this.commands.push(request.command);
    return {
      cmdId: "cmd_1",
      stdout: "ok\n",
      stderr: "",
      exitCode: 0,
    };
  }

  async deleteSession(_sessionId: string): Promise<void> {}
}

class FakeDaytonaFileSystem implements DaytonaSandboxFileSystemHandle {
  readonly deletedPaths: string[] = [];

  constructor(
    private readonly files = new Map<string, Uint8Array>(),
    private readonly modifiedAt = "2026-01-01T00:00:00.000Z",
  ) {}

  async uploadFile(file: Buffer, remotePath: string): Promise<void> {
    this.files.set(remotePath, Uint8Array.from(file));
  }

  async downloadFile(remotePath: string): Promise<Buffer> {
    const content = this.files.get(remotePath);
    if (!content) {
      throw new Error(`file not found: ${remotePath}`);
    }
    return Buffer.from(content);
  }

  async listFiles(path: string): Promise<
    Array<{
      group: string;
      isDir: boolean;
      modTime: string;
      mode: string;
      name: string;
      owner: string;
      permissions: string;
      size: number;
    }>
  > {
    const target = path.replace(/\/+$/, "");
    const children = new Map<string, ReturnType<FakeDaytonaFileSystem["toInfo"]>>();

    for (const [filePath, content] of this.files.entries()) {
      if (!filePath.startsWith(`${target}/`)) {
        continue;
      }
      const remainder = filePath.slice(target.length + 1);
      if (remainder.length === 0) {
        children.set(filePath, this.toInfo(filePath, false, content.byteLength));
        continue;
      }
      const nextSegment = remainder.split("/")[0]!;
      const childPath = `${target}/${nextSegment}`;
      if (remainder.includes("/")) {
        children.set(childPath, this.toInfo(childPath, true, 0));
        continue;
      }
      children.set(childPath, this.toInfo(childPath, false, content.byteLength));
    }

    return [...children.values()];
  }

  async getFileDetails(path: string): Promise<{
    group: string;
    isDir: boolean;
    modTime: string;
    mode: string;
    name: string;
    owner: string;
    permissions: string;
    size: number;
  }> {
    const content = this.files.get(path);
    if (content) {
      return this.toInfo(path, false, content.byteLength);
    }

    const isDirectory = [...this.files.keys()].some((candidate) =>
      candidate.startsWith(`${path.replace(/\/+$/, "")}/`),
    );
    if (isDirectory) {
      return this.toInfo(path, true, 0);
    }

    throw new Error(`file not found: ${path}`);
  }

  async deleteFile(path: string): Promise<void> {
    this.deletedPaths.push(path);
    this.files.delete(path);
  }

  private toInfo(path: string, isDir: boolean, size: number) {
    return {
      group: "daytona",
      isDir,
      modTime: this.modifiedAt,
      mode: isDir ? "755" : "644",
      name: path.split("/").at(-1)!,
      owner: "daytona",
      permissions: isDir ? "drwxr-xr-x" : "-rw-r--r--",
      size,
    };
  }
}

class FakeDaytonaSandbox implements DaytonaSandboxHandle {
  readonly process: FakeDaytonaProcess;
  readonly fs: FakeDaytonaFileSystem;
  readonly recoverable?: boolean;
  startCalls = 0;
  stopCalls = 0;
  archiveCalls = 0;
  deleteCalls = 0;
  recoverCalls = 0;
  waitCalls = 0;
  refreshCalls = 0;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly state: string,
    private workDir = "/workspace",
    recoverable?: boolean,
    files?: Map<string, Uint8Array>,
  ) {
    if (recoverable !== undefined) {
      this.recoverable = recoverable;
    }
    this.process = new FakeDaytonaProcess();
    this.fs = new FakeDaytonaFileSystem(files);
  }

  async getWorkDir(): Promise<string | undefined> {
    return this.workDir;
  }

  async start(): Promise<void> {
    this.startCalls += 1;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  async archive(): Promise<void> {
    this.archiveCalls += 1;
  }

  async delete(): Promise<void> {
    this.deleteCalls += 1;
  }

  async recover(): Promise<void> {
    this.recoverCalls += 1;
  }

  async waitUntilStarted(): Promise<void> {
    this.waitCalls += 1;
  }

  async refreshData(): Promise<void> {
    this.refreshCalls += 1;
  }
}

class FakeDaytonaClient implements DaytonaSandboxClientLike {
  readonly verifyCalls = 0;
  readonly createRequests: DaytonaSandboxCreateRequest[] = [];
  readonly createdSandboxes: FakeDaytonaSandbox[] = [];

  constructor(
    readonly sandboxes = new Map<string, FakeDaytonaSandbox>(),
    readonly volumes = new Map<string, DaytonaSandboxVolumeHandle>(),
  ) {}

  async verifyConnection(): Promise<void> {}

  async getSandbox(idOrName: string): Promise<DaytonaSandboxHandle | undefined> {
    return this.sandboxes.get(idOrName);
  }

  async createSandbox(request: DaytonaSandboxCreateRequest): Promise<DaytonaSandboxHandle> {
    this.createRequests.push(request);
    const sandbox = new FakeDaytonaSandbox(
      `created_${request.name ?? "sandbox"}`,
      request.name ?? "sandbox",
      "started",
      "/workspace/app",
    );
    this.createdSandboxes.push(sandbox);
    this.sandboxes.set(request.name ?? sandbox.id, sandbox);
    this.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }

  async getVolumeByName(name: string, create?: boolean): Promise<DaytonaSandboxVolumeHandle> {
    const volume = this.volumes.get(name);
    if (volume) {
      return volume;
    }
    if (!create) {
      throw new Error(`volume not found: ${name}`);
    }
    const created = { id: `volume_${name}`, name };
    this.volumes.set(name, created);
    return created;
  }

  async getVolumeById(volumeId: string): Promise<DaytonaSandboxVolumeHandle | undefined> {
    return [...this.volumes.values()].find((volume) => volume.id === volumeId);
  }
}

describe("daytona sandbox integration", () => {
  it("verifies dependencies and handles create, reuse, start, recover, and recreate flows", async () => {
    const started = new FakeDaytonaSandbox("sandbox_started_id", "sandbox_started", "started");
    const stopped = new FakeDaytonaSandbox("sandbox_stopped_id", "sandbox_stopped", "stopped");
    const recoverable = new FakeDaytonaSandbox(
      "sandbox_recoverable_id",
      "sandbox_recoverable",
      "error",
      "/workspace",
      true,
    );
    const broken = new FakeDaytonaSandbox(
      "sandbox_broken_id",
      "sandbox_broken",
      "error",
      "/workspace",
      false,
    );
    const client = new FakeDaytonaClient(
      new Map([
        ["sandbox_started", started],
        ["sandbox_stopped", stopped],
        ["sandbox_recoverable", recoverable],
        ["sandbox_broken", broken],
      ]),
      new Map([["shared-cache", { id: "volume_shared", name: "shared-cache" }]]),
    );

    const provider = new DaytonaSandboxProvider({
      client,
      defaults: {
        labels: {
          team: "sdk",
        },
      },
    });

    await expect(provider.verifyDependencies()).resolves.toEqual({
      ok: true,
      issues: [],
    });

    const createdLease = await provider.provision({
      provider: "daytona",
      sandboxId: "sandbox_new",
      metadata: {
        daytona: {
          snapshot: "node-template",
          volumes: [
            {
              volumeName: "shared-cache",
              mountPath: "/cache",
            },
          ],
        },
      },
    });

    const startedLease = await provider.provision({
      provider: "daytona",
      sandboxId: "sandbox_started",
    });
    const stoppedLease = await provider.provision({
      provider: "daytona",
      sandboxId: "sandbox_stopped",
    });
    const recoveredLease = await provider.provision({
      provider: "daytona",
      sandboxId: "sandbox_recoverable",
    });
    const recreatedLease = await provider.provision({
      provider: "daytona",
      sandboxId: "sandbox_broken",
    });

    expect(createdLease).toMatchObject({
      platform: "daytona",
      provider: "daytona",
      sandboxId: "created_sandbox_new",
      workspaceRoot: "/workspace/app",
      metadata: expect.objectContaining({
        sandboxName: "sandbox_new",
      }),
    });
    expect(client.createRequests[0]).toMatchObject({
      name: "sandbox_new",
      snapshot: "node-template",
      labels: {
        team: "sdk",
      },
      volumes: [
        {
          volumeId: "volume_shared",
          mountPath: "/cache",
        },
      ],
    });

    expect(startedLease.sandboxId).toBe("sandbox_started_id");
    expect(started.startCalls).toBe(0);

    expect(stoppedLease.sandboxId).toBe("sandbox_stopped_id");
    expect(stopped.startCalls).toBe(1);

    expect(recoveredLease.sandboxId).toBe("sandbox_recoverable_id");
    expect(recoverable.recoverCalls).toBe(1);

    expect(recreatedLease.sandboxId).toBe("created_sandbox_broken");
    expect(broken.deleteCalls).toBe(1);
    expect(client.createRequests.at(-1)).toMatchObject({
      name: "sandbox_broken",
    });
  });

  it("supports delete, stop, and archive release strategies", async () => {
    const sandbox = new FakeDaytonaSandbox("sandbox_release_id", "sandbox_release", "started");
    const client = new FakeDaytonaClient(new Map([["sandbox_release_id", sandbox]]), new Map());

    const deleteProvider = new DaytonaSandboxProvider({ client, releaseMode: "delete" });
    await deleteProvider.release?.({
      leaseId: "lease_delete",
      provider: "daytona",
      platform: "daytona",
      sandboxId: "sandbox_release_id",
      workspaceRoot: "/workspace",
    });
    expect(sandbox.deleteCalls).toBe(1);

    const stopProvider = new DaytonaSandboxProvider({ client, releaseMode: "stop" });
    await stopProvider.release?.({
      leaseId: "lease_stop",
      provider: "daytona",
      platform: "daytona",
      sandboxId: "sandbox_release_id",
      workspaceRoot: "/workspace",
    });
    expect(sandbox.stopCalls).toBe(1);

    const archiveProvider = new DaytonaSandboxProvider({ client, releaseMode: "archive" });
    await archiveProvider.release?.({
      leaseId: "lease_archive",
      provider: "daytona",
      platform: "daytona",
      sandboxId: "sandbox_release_id",
      workspaceRoot: "/workspace",
    });
    expect(sandbox.archiveCalls).toBe(1);
  });

  it("routes exec, file operations, and snapshot restore through daytona sandbox handles", async () => {
    const sandbox = new FakeDaytonaSandbox(
      "sandbox_platform",
      "sandbox_platform",
      "started",
      "/workspace",
      undefined,
      new Map([
        ["/workspace/src/app.ts", asBytes("export const version = 1;\n")],
        ["/workspace/src/extra.ts", asBytes("export const extra = true;\n")],
      ]),
    );
    const client = new FakeDaytonaClient(new Map([["sandbox_platform", sandbox]]), new Map());

    const platform = new DaytonaSandboxPlatform({ client });
    const instance = await platform.create({
      leaseId: "lease_daytona_platform",
      platform: "daytona",
      sandboxId: "sandbox_platform",
      workspaceRoot: "/workspace",
      mountPath: "/mnt/project",
    });

    await instance.writeFile("/mnt/project/src/new.ts", "export const created = true;\n");
    expect(await instance.readFile("/mnt/project/src/app.ts")).toContain("version = 1");

    const execResult = await instance.exec({
      command: "npm test",
      cwd: "/mnt/project/src",
      env: {
        FOO: "bar",
      },
      stdin: "hello from stdin",
    });

    expect(execResult.stdout).toContain("ok");
    expect(sandbox.process.commands[0]).toContain("/workspace/src");
    expect(sandbox.process.commands[0]).toContain("FOO");
    expect(sandbox.process.commands[0]).toContain("npm test");
    expect(sandbox.process.commands[0]).toContain("__RENX_STDIN_");
    expect(sandbox.process.commands[0]).toContain("hello from stdin");

    expect(await instance.statPath("/mnt/project/src/app.ts")).toEqual(
      expect.objectContaining({
        path: "/workspace/src/app.ts",
        isDirectory: false,
      }),
    );
    expect(await instance.listFiles("/mnt/project/src")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/workspace/src/app.ts",
          isDirectory: false,
        }),
        expect.objectContaining({
          path: "/workspace/src/new.ts",
          isDirectory: false,
        }),
      ]),
    );

    const snapshot = await instance.captureSnapshot("snapshot_daytona");
    await instance.writeFile("/mnt/project/src/after.ts", "after\n");
    await instance.restoreSnapshot(snapshot);

    await expect(instance.readFile("/mnt/project/src/after.ts")).rejects.toThrow(/file/i);
    expect(sandbox.fs.deletedPaths).toContain("/workspace/src/after.ts");
    await instance.dispose();
  });
});

import { describe, expect, it } from "vitest";

import type { FileInfo } from "@renx/agent";
import { ConnectionSandboxPlatform } from "@renx/agent-sandbox";
import type { SandboxLease, SandboxRuntimeConnection } from "@renx/agent-sandbox";

const asBytes = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "utf8"));

class FakeRuntimeConnection implements SandboxRuntimeConnection {
  readonly id = "fake-runtime";
  readonly deletedPaths: string[][] = [];

  constructor(private readonly files = new Map<string, Uint8Array>()) {}

  async execute(request: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    stdin?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs?: number;
    truncated?: boolean;
  }> {
    const envSuffix =
      request.env && Object.keys(request.env).length > 0
        ? ` env=${JSON.stringify(request.env)}`
        : "";
    return {
      stdout: `exec:${request.cwd ?? ""}:${request.command}${envSuffix}`,
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    };
  }

  async uploadFiles(
    files: Array<{ path: string; content: Uint8Array }>,
  ): Promise<Array<{ path: string; error?: string }>> {
    for (const file of files) {
      this.files.set(file.path, Uint8Array.from(file.content));
    }
    return files.map((file) => ({ path: file.path }));
  }

  async downloadFiles(
    paths: string[],
  ): Promise<Array<{ path: string; content?: Uint8Array; error?: string }>> {
    return paths.map((path) => {
      const content = this.files.get(path);
      return content ? { path, content } : { path, error: "file_not_found" };
    });
  }

  async listFiles(path: string): Promise<FileInfo[]> {
    const directory = path.replace(/\/+$/, "") || "/";
    const children = new Map<string, FileInfo>();

    for (const filePath of this.files.keys()) {
      if (filePath === directory) {
        const content = this.files.get(filePath)!;
        children.set(filePath, {
          path: filePath,
          isDirectory: false,
          size: content.byteLength,
          modifiedAt: "2026-01-01T00:00:00.000Z",
        });
        continue;
      }

      if (!filePath.startsWith(`${directory}/`)) {
        continue;
      }

      const remainder = filePath.slice(directory.length + 1);
      const nextSegment = remainder.split("/")[0]!;
      const childPath = `${directory}/${nextSegment}`.replaceAll("//", "/");
      if (remainder.includes("/")) {
        children.set(childPath, {
          path: childPath,
          isDirectory: true,
          modifiedAt: "2026-01-01T00:00:00.000Z",
        });
        continue;
      }

      const content = this.files.get(filePath)!;
      children.set(childPath, {
        path: childPath,
        isDirectory: false,
        size: content.byteLength,
        modifiedAt: "2026-01-01T00:00:00.000Z",
      });
    }

    if (children.size === 0 && directory !== "/workspace") {
      return [];
    }

    return [...children.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  async statPath(path: string): Promise<FileInfo | undefined> {
    const content = this.files.get(path);
    if (content) {
      return {
        path,
        isDirectory: false,
        size: content.byteLength,
        modifiedAt: "2026-01-01T00:00:00.000Z",
      };
    }

    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(`${path.replace(/\/+$/, "")}/`)) {
        return {
          path,
          isDirectory: true,
          modifiedAt: "2026-01-01T00:00:00.000Z",
        };
      }
    }

    return undefined;
  }

  async deletePaths(paths: string[]): Promise<void> {
    this.deletedPaths.push([...paths].sort());
    for (const path of paths) {
      this.files.delete(path);
    }
  }
}

class FakeRuntimePlatform extends ConnectionSandboxPlatform {
  readonly kind = "fake-runtime";

  constructor(private readonly connection: FakeRuntimeConnection) {
    super();
  }

  protected async connect(_lease: SandboxLease): Promise<SandboxRuntimeConnection> {
    return this.connection;
  }
}

describe("connection sandbox platform", () => {
  it("lets a backend implement only runtime primitives while the shared platform provides sessions, path mapping, and snapshot restore", async () => {
    const connection = new FakeRuntimeConnection(
      new Map([
        ["/workspace/src/app.ts", asBytes("export const version = 1;\n")],
        ["/workspace/src/extra.ts", asBytes("export const extra = true;\n")],
      ]),
    );
    const platform = new FakeRuntimePlatform(connection);

    const instance = await platform.create({
      leaseId: "lease_fake",
      platform: "fake-runtime",
      workspaceRoot: "/workspace",
      mountPath: "/mnt/project",
    });

    const session = await instance.createSession({ cwd: "/mnt/project" });
    expect((await instance.exec({ command: "pwd", sessionId: session.id })).stdout).toBe(
      "/workspace",
    );

    await instance.exec({ command: "cd src", sessionId: session.id });
    const execResult = await instance.exec({
      command: "npm test",
      sessionId: session.id,
      env: { NODE_ENV: "test" },
    });
    expect(execResult.stdout).toContain("exec:/workspace/src:npm test");
    expect(execResult.stdout).toContain('"NODE_ENV":"test"');

    expect(await instance.readFile("/mnt/project/src/app.ts")).toContain("version = 1");
    await instance.writeFile("/mnt/project/src/new.ts", "export const created = true;\n");
    expect(await instance.readFile("/mnt/project/src/new.ts")).toContain("created = true");

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
    expect(await instance.statPath("/mnt/project/src")).toEqual(
      expect.objectContaining({
        path: "/workspace/src",
        isDirectory: true,
      }),
    );

    const snapshot = await instance.captureSnapshot("snapshot_fake");
    await instance.writeFile("/mnt/project/src/app.ts", "export const version = 2;\n");
    await instance.writeFile("/mnt/project/src/after.ts", "after\n");

    await instance.restoreSnapshot(snapshot);

    expect(await instance.readFile("/mnt/project/src/app.ts")).toContain("version = 1");
    await expect(instance.readFile("/mnt/project/src/after.ts")).rejects.toThrow(/file/i);
    expect(connection.deletedPaths).toEqual(expect.arrayContaining([["/workspace/src/after.ts"]]));

    await instance.dispose();
  });
});

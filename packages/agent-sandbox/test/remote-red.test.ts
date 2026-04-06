import { describe, expect, it } from "vitest";

import { RemoteSandboxPlatform, RemoteSandboxProvider } from "@renx/agent-sandbox";
import type { RemoteSandboxRequest, RemoteSandboxResponse } from "@renx/agent-sandbox";

const asBase64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

const utf8Size = (value: string): number => Buffer.byteLength(value, "utf8");

describe("remote sandbox integration", () => {
  it("verifies remote service health, provisions new sandboxes, reuses healthy ones, recreates failed ones, and releases them", async () => {
    const requests: RemoteSandboxRequest[] = [];
    const sandboxes = new Map<
      string,
      { status: "ready" | "failed"; workspaceRoot: string; mountPath?: string }
    >([
      ["sandbox_ready", { status: "ready", workspaceRoot: "/workspace" }],
      ["sandbox_failed", { status: "failed", workspaceRoot: "/workspace" }],
    ]);

    const transport = async (request: RemoteSandboxRequest): Promise<RemoteSandboxResponse> => {
      requests.push(request);

      if (request.method === "GET" && request.path === "/health") {
        return {
          status: 200,
          body: {
            ok: true,
          },
        };
      }

      if (request.method === "GET" && request.path.startsWith("/sandboxes/")) {
        const sandboxId = request.path.slice("/sandboxes/".length);
        const sandbox = sandboxes.get(sandboxId);
        return sandbox
          ? {
              status: 200,
              body: {
                sandboxId,
                workspaceRoot: sandbox.workspaceRoot,
                ...(sandbox.mountPath ? { mountPath: sandbox.mountPath } : {}),
                status: sandbox.status,
              },
            }
          : {
              status: 404,
              body: {
                error: "not_found",
              },
            };
      }

      if (request.method === "POST" && request.path === "/sandboxes") {
        const body = request.body as {
          sandboxId: string;
          workspaceRoot: string;
          mountPath?: string;
        };
        sandboxes.set(body.sandboxId, {
          status: "ready",
          workspaceRoot: body.workspaceRoot,
          ...(body.mountPath ? { mountPath: body.mountPath } : {}),
        });
        return {
          status: 200,
          body: {
            sandboxId: body.sandboxId,
            workspaceRoot: body.workspaceRoot,
            ...(body.mountPath ? { mountPath: body.mountPath } : {}),
            status: "ready",
          },
        };
      }

      if (request.method === "DELETE" && request.path.startsWith("/sandboxes/")) {
        const sandboxId = request.path.slice("/sandboxes/".length);
        sandboxes.delete(sandboxId);
        return {
          status: 204,
          body: undefined,
        };
      }

      throw new Error(`Unexpected remote request: ${request.method} ${request.path}`);
    };

    const provider = new RemoteSandboxProvider({
      baseUrl: "https://sandbox.example.com",
      workspaceRoot: "/workspace",
      transport,
    });

    expect(await provider.verifyDependencies()).toEqual({
      ok: true,
      issues: [],
    });

    const freshLease = await provider.provision({
      provider: "remote-http",
      sandboxId: "sandbox_fresh",
      leaseId: "lease_remote_fresh",
      workspaceRoot: "/workspace",
      mountPath: "/mnt/project",
    });

    const reusedLease = await provider.provision({
      provider: "remote-http",
      sandboxId: "sandbox_ready",
      leaseId: "lease_remote_ready",
      workspaceRoot: "/workspace",
    });

    const recreatedLease = await provider.provision({
      provider: "remote-http",
      sandboxId: "sandbox_failed",
      leaseId: "lease_remote_failed",
      workspaceRoot: "/workspace",
    });

    await provider.release(reusedLease);

    expect(freshLease).toMatchObject({
      provider: "remote-http",
      platform: "remote-http",
      sandboxId: "sandbox_fresh",
      workspaceRoot: "/workspace",
      mountPath: "/mnt/project",
    });
    expect(reusedLease).toMatchObject({
      sandboxId: "sandbox_ready",
      workspaceRoot: "/workspace",
    });
    expect(recreatedLease).toMatchObject({
      sandboxId: "sandbox_failed",
      workspaceRoot: "/workspace",
    });

    expect(
      requests.some(
        (request) => request.method === "DELETE" && request.path === "/sandboxes/sandbox_failed",
      ),
    ).toBe(true);
    expect(
      requests.some(
        (request) => request.method === "DELETE" && request.path === "/sandboxes/sandbox_ready",
      ),
    ).toBe(true);
  });

  it("reports remote dependency failure when health checks fail", async () => {
    const provider = new RemoteSandboxProvider({
      baseUrl: "https://sandbox.example.com",
      transport: async () => ({
        status: 503,
        body: {
          error: "service_unavailable",
        },
      }),
    });

    await expect(provider.verifyDependencies()).resolves.toEqual({
      ok: false,
      issues: [expect.stringMatching(/503|health|remote/i)],
    });
  });

  it("routes exec, upload, and download through the remote sandbox transport", async () => {
    const requests: RemoteSandboxRequest[] = [];
    const files = new Map<string, { base64: string; modifiedAt: string }>();
    const modifiedAt = "2026-01-01T00:00:00.000Z";

    const transport = async (request: RemoteSandboxRequest): Promise<RemoteSandboxResponse> => {
      requests.push(request);

      if (request.method === "POST" && request.path === "/sandboxes/sandbox_remote/exec") {
        return {
          status: 200,
          body: {
            stdout: "hello\n",
            stderr: "",
            exitCode: 0,
          },
        };
      }

      if (request.method === "POST" && request.path === "/sandboxes/sandbox_remote/files:upload") {
        const body = request.body as {
          files: Array<{ path: string; base64: string }>;
        };
        for (const file of body.files) {
          files.set(file.path, { base64: file.base64, modifiedAt });
        }
        return {
          status: 200,
          body: {
            files: body.files.map((file) => ({
              path: file.path,
            })),
          },
        };
      }

      if (
        request.method === "POST" &&
        request.path === "/sandboxes/sandbox_remote/files:download"
      ) {
        const body = request.body as { paths: string[] };
        return {
          status: 200,
          body: {
            files: body.paths.map((path) =>
              files.has(path)
                ? {
                    path,
                    base64: files.get(path)!.base64,
                  }
                : {
                    path,
                    error: "file_not_found",
                  },
            ),
          },
        };
      }

      if (request.method === "POST" && request.path === "/sandboxes/sandbox_remote/files:list") {
        const body = request.body as { path: string };
        const target = body.path.replace(/\/+$/, "");
        const directChildren = new Map<string, Record<string, unknown>>();

        for (const [path, file] of files.entries()) {
          if (path === target) {
            return {
              status: 200,
              body: {
                entries: [
                  {
                    path,
                    isDirectory: false,
                    size: utf8Size(Buffer.from(file.base64, "base64").toString("utf8")),
                    modifiedAt: file.modifiedAt,
                  },
                ],
              },
            };
          }

          if (!path.startsWith(`${target}/`)) {
            continue;
          }

          const remainder = path.slice(target.length + 1);
          const nextSegment = remainder.split("/")[0]!;
          const childPath = `${target}/${nextSegment}`;
          if (remainder.includes("/")) {
            directChildren.set(childPath, {
              path: childPath,
              isDirectory: true,
              modifiedAt,
            });
            continue;
          }

          directChildren.set(childPath, {
            path: childPath,
            isDirectory: false,
            size: utf8Size(Buffer.from(file.base64, "base64").toString("utf8")),
            modifiedAt: file.modifiedAt,
          });
        }

        return {
          status: 200,
          body: {
            entries: [...directChildren.values()],
          },
        };
      }

      if (request.method === "POST" && request.path === "/sandboxes/sandbox_remote/files:stat") {
        const body = request.body as { path: string };
        const file = files.get(body.path);
        if (file) {
          return {
            status: 200,
            body: {
              entry: {
                path: body.path,
                isDirectory: false,
                size: utf8Size(Buffer.from(file.base64, "base64").toString("utf8")),
                modifiedAt: file.modifiedAt,
              },
            },
          };
        }

        const hasChildren = [...files.keys()].some((path) => path.startsWith(`${body.path}/`));
        return {
          status: 200,
          body: {
            ...(hasChildren
              ? {
                  entry: {
                    path: body.path,
                    isDirectory: true,
                    modifiedAt,
                  },
                }
              : {}),
          },
        };
      }

      if (request.method === "POST" && request.path === "/sandboxes/sandbox_remote/files:delete") {
        const body = request.body as { paths: string[] };
        for (const path of body.paths) {
          files.delete(path);
        }
        return {
          status: 200,
          body: {
            ok: true,
          },
        };
      }

      throw new Error(`Unexpected remote request: ${request.method} ${request.path}`);
    };

    const platform = new RemoteSandboxPlatform({
      baseUrl: "https://sandbox.example.com",
      transport,
    });
    const instance = await platform.create({
      leaseId: "lease_remote_platform",
      sandboxId: "sandbox_remote",
      platform: "remote-http",
      workspaceRoot: "/workspace",
      mountPath: "/mnt/project",
      metadata: {
        sandboxBaseUrl: "https://sandbox.example.com",
      },
    });

    await instance.writeFile("/mnt/project/src/app.ts", "export const value = 1;\n");
    expect(await instance.readFile("/mnt/project/src/app.ts")).toContain("value = 1");
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
      ]),
    );

    const execResult = await instance.exec({
      command: "echo hello",
      cwd: "/mnt/project/src",
      env: {
        FOO: "bar",
      },
      timeoutMs: 2500,
    });
    expect(execResult.stdout.trim()).toBe("hello");

    const execRequest = requests.find(
      (request) => request.method === "POST" && request.path === "/sandboxes/sandbox_remote/exec",
    );
    expect(execRequest?.body).toMatchObject({
      command: "echo hello",
      cwd: "/workspace/src",
      env: {
        FOO: "bar",
      },
      timeoutMs: 2500,
    });

    const uploadRequest = requests.find(
      (request) =>
        request.method === "POST" && request.path === "/sandboxes/sandbox_remote/files:upload",
    );
    expect(uploadRequest?.body).toMatchObject({
      files: [
        {
          path: "/workspace/src/app.ts",
          base64: asBase64("export const value = 1;\n"),
        },
      ],
    });

    const snapshot = await instance.captureSnapshot("snapshot_remote");
    await instance.writeFile("/mnt/project/src/extra.ts", "export const extra = true;\n");
    await instance.restoreSnapshot(snapshot);
    await expect(instance.readFile("/mnt/project/src/extra.ts")).rejects.toThrow(/file/i);

    expect(
      requests.some(
        (request) =>
          request.method === "POST" && request.path === "/sandboxes/sandbox_remote/files:delete",
      ),
    ).toBe(true);

    await instance.dispose();
  });
});

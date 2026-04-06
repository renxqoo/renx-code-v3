import { describe, expect, it } from "vitest";

import { DockerSandboxPlatform, DockerSandboxProvider } from "@renx/agent-sandbox";
import type { DockerCommandRequest, DockerCommandResult } from "@renx/agent-sandbox";

const asBytes = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "utf8"));

const dockerResult = (stdout = "", stderr = "", exitCode = 0): DockerCommandResult => ({
  stdout: asBytes(stdout),
  stderr: asBytes(stderr),
  exitCode,
});

describe("docker sandbox integration", () => {
  it("verifies docker, pulls missing images, provisions isolated containers, and reconnects existing sandboxes", async () => {
    const requests: DockerCommandRequest[] = [];

    const runner = async (request: DockerCommandRequest): Promise<DockerCommandResult> => {
      requests.push(request);

      if (request.args[0] === "version") {
        return dockerResult("Docker version 26.1.0");
      }
      if (request.args[0] === "image" && request.args[1] === "inspect") {
        return dockerResult("", "missing image", 1);
      }
      if (request.args[0] === "pull") {
        return dockerResult("pulled");
      }
      if (request.args[0] === "inspect" && request.args.at(-1) === "sandbox_main") {
        return dockerResult("", "missing container", 1);
      }
      if (request.args[0] === "inspect" && request.args.at(-1) === "sandbox_stopped") {
        return dockerResult("false");
      }
      if (request.args[0] === "run") {
        return dockerResult("sandbox_main\n");
      }
      if (request.args[0] === "start") {
        return dockerResult("sandbox_stopped\n");
      }
      if (request.args[0] === "rm") {
        return dockerResult("");
      }

      throw new Error(`Unexpected docker request: ${request.args.join(" ")}`);
    };

    const provider = new DockerSandboxProvider({
      image: "node:20-bookworm-slim",
      workspaceRoot: "/workspace",
      pullPolicy: "if-not-present",
      runner,
    });

    expect(await provider.verifyDependencies()).toEqual({
      ok: true,
      issues: [],
    });

    await provider.initialize();

    const freshLease = await provider.provision({
      provider: "docker",
      leaseId: "lease_docker",
      sandboxId: "sandbox_main",
      workspaceRoot: "/workspace",
      mountPath: "/host/project",
    });

    const reconnectedLease = await provider.provision({
      provider: "docker",
      leaseId: "lease_reconnected",
      sandboxId: "sandbox_stopped",
      workspaceRoot: "/workspace",
      mountPath: "/host/project",
      policy: {
        allowNetwork: true,
      },
    });

    await provider.release(reconnectedLease);

    expect(freshLease).toMatchObject({
      leaseId: "lease_docker",
      sandboxId: "sandbox_main",
      provider: "docker",
      platform: "docker",
      workspaceRoot: "/workspace",
      mountPath: "/host/project",
    });
    expect(reconnectedLease).toMatchObject({
      leaseId: "lease_reconnected",
      sandboxId: "sandbox_stopped",
      provider: "docker",
      platform: "docker",
    });

    const runRequest = requests.find(
      (request) => request.args[0] === "run" && request.args.includes("sandbox_main"),
    );
    expect(runRequest).toBeDefined();
    expect(runRequest?.args).toEqual(
      expect.arrayContaining([
        "run",
        "-d",
        "--name",
        "sandbox_main",
        "--network",
        "none",
        "--workdir",
        "/workspace",
        "-v",
        "/host/project:/workspace",
        "node:20-bookworm-slim",
      ]),
    );
    expect(
      requests.some(
        (request) => request.args[0] === "start" && request.args.at(-1) === "sandbox_stopped",
      ),
    ).toBe(true);
    expect(
      requests.some(
        (request) =>
          request.args[0] === "rm" &&
          request.args[1] === "-f" &&
          request.args[2] === "sandbox_stopped",
      ),
    ).toBe(true);
  });

  it("reports missing docker dependencies when the docker cli is unavailable", async () => {
    const provider = new DockerSandboxProvider({
      runner: async () => {
        throw new Error("spawn docker ENOENT");
      },
    });

    await expect(provider.verifyDependencies()).resolves.toEqual({
      ok: false,
      issues: [expect.stringMatching(/docker/i)],
    });
  });

  it("routes exec, upload, and download through docker exec with translated workspace paths", async () => {
    const requests: DockerCommandRequest[] = [];
    const files = new Map<string, Uint8Array>();

    const runner = async (request: DockerCommandRequest): Promise<DockerCommandResult> => {
      requests.push(request);

      if (request.args[0] !== "exec") {
        throw new Error(`Unexpected docker request: ${request.args.join(" ")}`);
      }

      if (request.args.includes("node") && request.stdin) {
        const targetPath = request.args.at(-1)!;
        files.set(targetPath, request.stdin);
        return dockerResult("");
      }

      if (request.args.includes("node")) {
        const targetPath = request.args.at(-1)!;
        const content = files.get(targetPath);
        if (!content) {
          return {
            stdout: new Uint8Array(),
            stderr: asBytes("file_not_found"),
            exitCode: 20,
          };
        }
        return {
          stdout: content,
          stderr: new Uint8Array(),
          exitCode: 0,
        };
      }

      if (request.args.includes("sh") && request.args.at(-1) === "echo hello") {
        return dockerResult("hello\n");
      }

      throw new Error(`Unexpected docker exec request: ${request.args.join(" ")}`);
    };

    const platform = new DockerSandboxPlatform({
      runner,
    });
    const instance = await platform.create({
      leaseId: "lease_docker_platform",
      sandboxId: "sandbox_platform",
      platform: "docker",
      workspaceRoot: "/workspace",
      mountPath: "/host/project",
    });

    await instance.writeFile("/host/project/src/app.ts", "export const value = 1;\n");
    expect(await instance.readFile("/host/project/src/app.ts")).toContain("value = 1");

    const execResult = await instance.exec({
      command: "echo hello",
      cwd: "/host/project/src",
      env: {
        FOO: "bar",
      },
      timeoutMs: 4321,
    });

    expect(execResult.stdout.trim()).toBe("hello");

    const uploadRequest = requests.find(
      (request) =>
        request.args[0] === "exec" &&
        !!request.stdin &&
        request.args.includes("/workspace/src/app.ts"),
    );
    expect(uploadRequest).toBeDefined();
    expect(uploadRequest?.args).toEqual(
      expect.arrayContaining(["exec", "-i", "sandbox_platform", "node"]),
    );

    const shellRequest = requests.find(
      (request) =>
        request.args[0] === "exec" &&
        request.args.includes("sh") &&
        request.args.at(-1) === "echo hello",
    );
    expect(shellRequest).toBeDefined();
    expect(shellRequest?.args).toEqual(
      expect.arrayContaining([
        "exec",
        "--workdir",
        "/workspace/src",
        "--env",
        "FOO=bar",
        "sandbox_platform",
        "sh",
        "-lc",
        "echo hello",
      ]),
    );
    expect(shellRequest?.timeoutMs).toBe(4321);

    await instance.dispose();
  });
});

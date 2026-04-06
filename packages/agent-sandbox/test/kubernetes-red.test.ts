import { describe, expect, it } from "vitest";

import { KubernetesSandboxPlatform, KubernetesSandboxProvider } from "@renx/agent-sandbox";
import type { KubectlCommandRequest, KubectlCommandResult } from "@renx/agent-sandbox";

const asBytes = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "utf8"));

const kubectlResult = (stdout = "", stderr = "", exitCode = 0): KubectlCommandResult => ({
  stdout: asBytes(stdout),
  stderr: asBytes(stderr),
  exitCode,
});

describe("kubernetes sandbox integration", () => {
  it("verifies kubectl, creates hardened pods, reconnects running sandboxes, and recreates failed pods", async () => {
    const requests: KubectlCommandRequest[] = [];
    const pods = new Map<
      string,
      { phase: "Running" | "Failed"; ready: boolean; manifest?: Record<string, unknown> }
    >([
      ["agents/sandbox_running", { phase: "Running", ready: true }],
      ["agents/sandbox_failed", { phase: "Failed", ready: false }],
    ]);

    const runner = async (request: KubectlCommandRequest): Promise<KubectlCommandResult> => {
      requests.push(request);

      if (request.args[0] === "version") {
        return kubectlResult('{"clientVersion":{"gitVersion":"v1.30.0"}}');
      }

      if (request.args[0] === "get" && request.args[1] === "pod") {
        const namespace = request.args[request.args.indexOf("-n") + 1]!;
        const podName = request.args[2]!;
        const pod = pods.get(`${namespace}/${podName}`);
        if (!pod) {
          return kubectlResult("", "NotFound", 1);
        }
        return kubectlResult(
          JSON.stringify({
            metadata: {
              name: podName,
              namespace,
            },
            status: {
              phase: pod.phase,
              conditions: [
                {
                  type: "Ready",
                  status: pod.ready ? "True" : "False",
                },
              ],
            },
          }),
        );
      }

      if (request.args[0] === "apply") {
        const manifest = JSON.parse(
          Buffer.from(request.stdin ?? new Uint8Array()).toString("utf8"),
        ) as {
          metadata: { name: string; namespace: string };
        };
        pods.set(`${manifest.metadata.namespace}/${manifest.metadata.name}`, {
          phase: "Running",
          ready: true,
          manifest,
        });
        return kubectlResult(`${manifest.metadata.name} created`);
      }

      if (request.args[0] === "delete" && request.args[1] === "pod") {
        const namespace = request.args[request.args.indexOf("-n") + 1]!;
        const podName = request.args[2]!;
        pods.delete(`${namespace}/${podName}`);
        return kubectlResult(`${podName} deleted`);
      }

      throw new Error(`Unexpected kubectl request: ${request.args.join(" ")}`);
    };

    const provider = new KubernetesSandboxProvider({
      image: "node:20-bookworm-slim",
      namespace: "agents",
      workspaceRoot: "/workspace",
      labels: {
        "team.name": "sdk",
      },
      runner,
    });

    expect(await provider.verifyDependencies()).toEqual({
      ok: true,
      issues: [],
    });

    const freshLease = await provider.provision({
      provider: "kubernetes",
      sandboxId: "sandbox_fresh",
      leaseId: "lease_k8s_fresh",
      workspaceRoot: "/workspace",
      policy: {
        allowNetwork: false,
      },
    });

    const runningLease = await provider.provision({
      provider: "kubernetes",
      sandboxId: "sandbox_running",
      leaseId: "lease_k8s_running",
      workspaceRoot: "/workspace",
    });

    const recreatedLease = await provider.provision({
      provider: "kubernetes",
      sandboxId: "sandbox_failed",
      leaseId: "lease_k8s_failed",
      workspaceRoot: "/workspace",
    });

    await provider.release(runningLease);

    expect(freshLease).toMatchObject({
      sandboxId: "sandbox_fresh",
      platform: "kubernetes",
      provider: "kubernetes",
      workspaceRoot: "/workspace",
      metadata: expect.objectContaining({
        namespace: "agents",
        podName: "sandbox_fresh",
        containerName: "workspace",
      }),
    });
    expect(runningLease.metadata).toMatchObject({
      namespace: "agents",
      podName: "sandbox_running",
    });
    expect(recreatedLease.metadata).toMatchObject({
      namespace: "agents",
      podName: "sandbox_failed",
    });

    const appliedFreshManifest = pods.get("agents/sandbox_fresh")?.manifest as Record<string, any>;
    expect(appliedFreshManifest).toBeDefined();
    expect(appliedFreshManifest).toMatchObject({
      kind: "Pod",
      metadata: {
        name: "sandbox_fresh",
        namespace: "agents",
        labels: expect.objectContaining({
          "renx.sandbox.provider": "kubernetes",
          "renx.sandbox.network": "blocked",
          "team.name": "sdk",
        }),
      },
      spec: {
        automountServiceAccountToken: false,
        restartPolicy: "Never",
        containers: [
          expect.objectContaining({
            name: "workspace",
            image: "node:20-bookworm-slim",
            workingDir: "/workspace",
            securityContext: expect.objectContaining({
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: false,
              runAsNonRoot: true,
            }),
            volumeMounts: [
              expect.objectContaining({
                name: "workspace",
                mountPath: "/workspace",
              }),
            ],
          }),
        ],
        volumes: [
          expect.objectContaining({
            name: "workspace",
            emptyDir: {},
          }),
        ],
      },
    });

    expect(
      requests.some(
        (request) =>
          request.args[0] === "delete" &&
          request.args[1] === "pod" &&
          request.args[2] === "sandbox_failed",
      ),
    ).toBe(true);
    expect(
      requests.some(
        (request) =>
          request.args[0] === "delete" &&
          request.args[1] === "pod" &&
          request.args[2] === "sandbox_running",
      ),
    ).toBe(true);
  });

  it("blocks unsafe hostPath mounts unless explicitly enabled", async () => {
    const provider = new KubernetesSandboxProvider({
      runner: async () => kubectlResult("ok"),
    });

    await expect(
      provider.provision({
        provider: "kubernetes",
        sandboxId: "sandbox_hostpath",
        leaseId: "lease_hostpath",
        workspaceRoot: "/workspace",
        mountPath: "/var/lib/data",
      }),
    ).rejects.toThrow(/hostpath|host path/i);
  });

  it("routes exec, upload, and download through kubectl exec with namespace and container targeting", async () => {
    const requests: KubectlCommandRequest[] = [];
    const files = new Map<string, Uint8Array>();

    const runner = async (request: KubectlCommandRequest): Promise<KubectlCommandResult> => {
      requests.push(request);

      if (request.args[0] !== "exec") {
        throw new Error(`Unexpected kubectl request: ${request.args.join(" ")}`);
      }

      const commandStart = request.args.indexOf("--");
      const commandArgs = request.args.slice(commandStart + 1);

      if (commandArgs[0] === "node" && request.stdin) {
        const targetPath = commandArgs.at(-1)!;
        files.set(targetPath, request.stdin);
        return kubectlResult("");
      }

      if (commandArgs[0] === "node") {
        const targetPath = commandArgs.at(-1)!;
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

      if (commandArgs[0] === "sh") {
        return kubectlResult("hello\n");
      }

      throw new Error(`Unexpected kubectl exec request: ${request.args.join(" ")}`);
    };

    const platform = new KubernetesSandboxPlatform({
      namespace: "agents",
      runner,
    });
    const instance = await platform.create({
      leaseId: "lease_k8s_platform",
      sandboxId: "sandbox_platform",
      platform: "kubernetes",
      workspaceRoot: "/workspace",
      mountPath: "/host/project",
      metadata: {
        namespace: "agents",
        podName: "sandbox_platform",
        containerName: "workspace",
      },
    });

    await instance.writeFile("/host/project/src/app.ts", "export const value = 1;\n");
    expect(await instance.readFile("/host/project/src/app.ts")).toContain("value = 1");

    const execResult = await instance.exec({
      command: "echo hello",
      cwd: "/host/project/src",
      env: {
        FOO: "bar",
      },
      timeoutMs: 3333,
    });

    expect(execResult.stdout.trim()).toBe("hello");

    const shellRequest = requests.find(
      (request) =>
        request.args[0] === "exec" &&
        request.args.includes("sandbox_platform") &&
        request.args.includes("sh"),
    );
    expect(shellRequest).toBeDefined();
    expect(shellRequest?.args).toEqual(
      expect.arrayContaining([
        "exec",
        "-n",
        "agents",
        "sandbox_platform",
        "-c",
        "workspace",
        "--",
        "sh",
        "-lc",
      ]),
    );
    expect(shellRequest?.args.at(-1)).toContain("cd '/workspace/src'");
    expect(shellRequest?.args.at(-1)).toContain("export FOO='bar'");
    expect(shellRequest?.args.at(-1)).toContain("echo hello");
    expect(shellRequest?.timeoutMs).toBe(3333);

    const uploadRequest = requests.find(
      (request) =>
        request.args[0] === "exec" &&
        request.args.includes("-i") &&
        request.args.includes("/workspace/src/app.ts"),
    );
    expect(uploadRequest).toBeDefined();

    await instance.dispose();
  });
});

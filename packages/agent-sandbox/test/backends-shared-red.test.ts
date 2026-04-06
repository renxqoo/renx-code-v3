import { describe, expect, it } from "vitest";

import type { SandboxExecutionBackend, SandboxLease } from "@renx/agent-sandbox";
import { SandboxPlatformError, SandboxProviderError } from "@renx/agent-sandbox";

import { createCommandRuntimeConnection } from "../src/backends/shared/command-runtime-connection";
import {
  buildDaytonaLeaseMetadata,
  buildKubernetesLeaseMetadata,
  buildRemoteLeaseMetadata,
  resolveDaytonaSandboxReference,
  resolveKubernetesLeaseTarget,
  resolveRemoteSandboxBaseUrl,
} from "../src/backends/shared/lease-metadata";
import { reconcileManagedResource } from "../src/backends/shared/managed-resource";
import {
  buildSandboxLease,
  ensureAbsolutePosixWorkspaceRoot,
  ensureProvisionPlatform,
  prepareSandboxWorkspace,
} from "../src/backends/shared/provider-helpers";
import {
  buildPosixShellCommand,
  buildPosixShellInvocation,
} from "../src/backends/shared/shell-command";
import {
  formatTransportErrorMessage,
  throwSandboxSurfaceError,
} from "../src/backends/shared/surface-errors";

const asBytes = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "utf8"));

describe("shared backend helpers", () => {
  it("builds reusable POSIX shell commands with cwd and quoted env prefixes", () => {
    expect(
      buildPosixShellCommand("node index.js", {
        cwd: "/workspace/src",
        env: {
          FOO: "bar baz",
          QUOTE: "it's",
        },
      }),
    ).toBe(
      "cd '/workspace/src' && export FOO='bar baz' && export QUOTE='it'\"'\"'s' && node index.js",
    );
  });

  it("builds full shell invocations with stdin piped through a deterministic marker", () => {
    const invocation = buildPosixShellInvocation("npm test", {
      cwd: "/workspace/src",
      env: {
        FOO: "bar",
      },
      stdin: "hello from stdin",
      createMarker: () => "__RENX_STDIN_TEST__",
    });

    expect(invocation.startsWith("sh -lc '")).toBe(true);
    expect(invocation).toContain("cd '\"'\"'/workspace/src'\"'\"'");
    expect(invocation).toContain("export FOO='\"'\"'bar'\"'\"'");
    expect(invocation).toContain("cat <<'\"'\"'__RENX_STDIN_TEST__'\"'\"' | (npm test)");
    expect(invocation).toContain("hello from stdin");
  });

  it("builds leases with reserved backend metadata winning over conflicting request metadata", () => {
    const lease = buildSandboxLease({
      provider: "kubernetes",
      platform: "kubernetes",
      leaseId: "lease_k8s",
      sandboxId: "sandbox_k8s",
      workspaceRoot: "/workspace",
      request: {
        provider: "kubernetes",
        metadata: {
          namespace: "wrong",
          podName: "wrong",
          preserved: "value",
        },
      },
      metadata: buildKubernetesLeaseMetadata({
        namespace: "agents",
        podName: "sandbox_k8s",
        containerName: "workspace",
        image: "node:20",
      }),
    });

    expect(lease.metadata).toEqual({
      namespace: "agents",
      podName: "sandbox_k8s",
      containerName: "workspace",
      image: "node:20",
      preserved: "value",
    });
  });

  it("resolves typed lease metadata consistently across kubernetes, remote, and daytona", () => {
    const kubernetesLease: SandboxLease = {
      leaseId: "lease_k8s",
      sandboxId: "sandbox_fallback",
      platform: "kubernetes",
      workspaceRoot: "/workspace",
      metadata: {
        namespace: "agents",
        podName: "sandbox_primary",
      },
    };
    expect(
      resolveKubernetesLeaseTarget(kubernetesLease, {
        namespace: "default",
        containerName: "workspace",
      }),
    ).toEqual({
      namespace: "agents",
      podName: "sandbox_primary",
      containerName: "workspace",
    });

    const remoteLease: SandboxLease = {
      leaseId: "lease_remote",
      platform: "remote-http",
      workspaceRoot: "/workspace",
      metadata: buildRemoteLeaseMetadata({
        sandboxBaseUrl: "https://sandbox.example.com",
      }),
    };
    expect(resolveRemoteSandboxBaseUrl(remoteLease, "https://fallback.example.com")).toBe(
      "https://sandbox.example.com",
    );

    const daytonaLease: SandboxLease = {
      leaseId: "lease_daytona",
      sandboxId: "sandbox_daytona_id",
      platform: "daytona",
      workspaceRoot: "/workspace",
      metadata: buildDaytonaLeaseMetadata({
        sandboxName: "sandbox_daytona",
        requestedName: "sandbox_requested",
      }),
    };
    expect(resolveDaytonaSandboxReference(daytonaLease)).toEqual({
      sandboxId: "sandbox_daytona_id",
      sandboxName: "sandbox_daytona",
      requestedName: "sandbox_requested",
    });
  });

  it("reconciles managed resources through shared reuse, resume, recover, wait, and replace semantics", async () => {
    const events: string[] = [];

    expect(
      await reconcileManagedResource({
        resource: { state: "ready" },
        classify: (resource) => (resource.state === "ready" ? "reuse" : "replace"),
      }),
    ).toEqual({ state: "ready" });

    expect(
      await reconcileManagedResource({
        resource: { state: "stopped" },
        classify: (resource) => (resource.state === "stopped" ? "resume" : "replace"),
        resume: async (resource) => {
          events.push("resume");
          return { state: `${resource.state}:started` };
        },
      }),
    ).toEqual({ state: "stopped:started" });

    expect(
      await reconcileManagedResource({
        resource: { state: "error" },
        classify: (resource) => (resource.state === "error" ? "recover" : "replace"),
        recover: async (resource) => {
          events.push("recover");
          return { state: `${resource.state}:recovered` };
        },
      }),
    ).toEqual({ state: "error:recovered" });

    expect(
      await reconcileManagedResource({
        resource: { state: "starting" },
        classify: (resource) => (resource.state === "starting" ? "wait" : "replace"),
        wait: async (resource) => {
          events.push("wait");
          return { state: `${resource.state}:ready` };
        },
      }),
    ).toEqual({ state: "starting:ready" });

    expect(
      await reconcileManagedResource({
        resource: { state: "failed" },
        classify: (resource) => (resource.state === "failed" ? "replace" : "reuse"),
        replace: async () => {
          events.push("replace");
        },
      }),
    ).toBeUndefined();

    expect(events).toEqual(["resume", "recover", "wait", "replace"]);
  });

  it("creates a reusable command runtime connection for command-backed platforms", async () => {
    const calls: Array<{
      args: string[];
      stdin?: Uint8Array;
      timeoutMs?: number;
    }> = [];

    const connection = createCommandRuntimeConnection({
      id: "command:runtime",
      invoke: async (request) => {
        calls.push(request);
        return {
          stdout: asBytes(request.args.includes("node") ? "" : "hello\n"),
          stderr: new Uint8Array(),
          exitCode: 0,
          durationMs: 12,
        };
      },
      buildExecuteArgs: (request) => [
        "exec",
        ...(request.stdin ? ["-i"] : []),
        "sandbox_runtime",
        "sh",
        "-lc",
        buildPosixShellCommand(request.command, {
          ...(request.cwd ? { cwd: request.cwd } : {}),
          ...(request.env ? { env: request.env } : {}),
        }),
      ],
      buildNodeArgs: (request) => [
        "exec",
        ...(request.stdin ? ["-i"] : []),
        "sandbox_runtime",
        "node",
        "-e",
        request.script,
        ...(request.args ?? []),
      ],
    });

    const result = await connection.execute({
      command: "echo hello",
      cwd: "/workspace/src",
      env: {
        FOO: "bar",
      },
      stdin: "stdin payload",
      timeoutMs: 321,
    });

    expect(result).toMatchObject({
      stdout: "hello\n",
      exitCode: 0,
      durationMs: 12,
    });
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining([
        "exec",
        "-i",
        "sandbox_runtime",
        "sh",
        "-lc",
        "cd '/workspace/src' && export FOO='bar' && echo hello",
      ]),
    );
    expect(Buffer.from(calls[0]!.stdin ?? new Uint8Array()).toString("utf8")).toBe("stdin payload");
    expect(calls[0]?.timeoutMs).toBe(321);

    await connection.uploadFiles([
      {
        path: "/workspace/src/app.ts",
        content: asBytes("export const value = 1;\n"),
      },
    ]);
    expect(calls[1]?.args).toEqual(
      expect.arrayContaining(["exec", "-i", "sandbox_runtime", "node"]),
    );
    expect(calls[1]?.args.at(-1)).toBe("/workspace/src/app.ts");
  });

  it("shares provider-side platform and workspace guards plus workspace preparation", async () => {
    expect(() =>
      ensureProvisionPlatform(
        {
          provider: "docker",
          platform: "remote-http",
        },
        "docker",
        "Docker sandbox provider",
      ),
    ).toThrow(/docker platform leases/i);

    expect(() => ensureAbsolutePosixWorkspaceRoot("workspace", "Docker sandbox")).toThrow(
      /absolute posix path/i,
    );

    const commands: string[] = [];
    await prepareSandboxWorkspace(
      {
        exec: async (command: string) => {
          commands.push(command);
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
          };
        },
      } as SandboxExecutionBackend,
      "/workspace/dir with space",
    );

    expect(commands).toEqual(["mkdir -p '/workspace/dir with space'"]);
  });

  it("normalizes provider and platform transport errors through one shared helper", () => {
    expect(
      formatTransportErrorMessage("Remote sandbox request failed", 503, {
        error: "service_unavailable",
      }),
    ).toBe('Remote sandbox request failed with status 503: {"error":"service_unavailable"}');

    expect(() => throwSandboxSurfaceError("provider", "provider failed")).toThrow(
      SandboxProviderError,
    );
    expect(() => throwSandboxSurfaceError("platform", "platform failed")).toThrow(
      SandboxPlatformError,
    );
  });
});

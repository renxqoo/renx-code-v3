import { describe, expect, it } from "vitest";

import type { AgentRunContext, AgentTool, ToolResult } from "@renx/agent";

import {
  DefaultSandboxManager,
  InMemorySandboxPlatform,
  InMemorySandboxSnapshotStore,
  LocalSandboxPlatform,
  SandboxBackend,
  SandboxBackendResolver,
  SandboxPolicyError,
  StaticSandboxPlatformRegistry,
} from "@renx/agent-sandbox";

const createRunContext = (): AgentRunContext => ({
  input: {
    messages: [
      {
        id: "msg_backend_1",
        messageId: "msg_backend_1",
        role: "user",
        content: "test",
        createdAt: new Date().toISOString(),
        source: "input",
      },
    ],
  },
  identity: { userId: "u1", tenantId: "t1", roles: [] },
  state: {
    runId: "run_1",
    messages: [],
    scratchpad: {},
    memory: {},
    stepCount: 0,
    status: "running",
  },
  services: {},
  metadata: {},
});

describe("sandbox manager/backend/resolver", () => {
  it("requires negotiated capabilities before constructing a sandbox backend", () => {
    const registry = new StaticSandboxPlatformRegistry();
    registry.register(new InMemorySandboxPlatform());

    const manager = new DefaultSandboxManager({
      registry,
      snapshotStore: new InMemorySandboxSnapshotStore(),
    });

    expect(
      () =>
        new SandboxBackend({
          manager,
          lease: {
            leaseId: "lease_missing_caps",
            platform: "memory",
            workspaceRoot: "/workspace",
          },
        }),
    ).toThrow(/capabilities/i);
  });

  it("supports sessions and snapshots while enforcing execution policy", async () => {
    const registry = new StaticSandboxPlatformRegistry();
    registry.register(new InMemorySandboxPlatform());

    const manager = new DefaultSandboxManager({
      registry,
      snapshotStore: new InMemorySandboxSnapshotStore(),
      defaultPolicy: {
        maxExecutionTimeoutMs: 200,
        blockedCommandPatterns: [/forbidden/i],
      },
    });

    const lease = {
      leaseId: "lease_backend",
      platform: "memory",
      workspaceRoot: "/workspace",
      capabilities: await manager.capabilitiesFor({
        leaseId: "lease_backend",
        platform: "memory",
        workspaceRoot: "/workspace",
      }),
    };

    const backend = new SandboxBackend({
      manager,
      lease,
    });

    expect(backend.capabilities()).toMatchObject({
      exec: true,
      filesystemRead: true,
      filesystemWrite: true,
      binaryRead: true,
      pathMetadata: true,
      snapshots: true,
      persistentSession: true,
    });

    await backend.writeFile("/workspace/src/app.ts", "export const value = 1;\n");
    const session = await backend.createSession({ cwd: "/workspace" });

    await backend.exec("cd src", { sessionId: session.id });
    expect((await backend.exec("pwd", { sessionId: session.id })).stdout.trim()).toBe(
      "/workspace/src",
    );

    const snapshot = await backend.captureSnapshot("snap_backend");
    expect(snapshot.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/app.ts",
        }),
      ]),
    );

    await backend.writeFile("/workspace/src/app.ts", "export const value = 2;\n");
    await backend.restoreSnapshot("snap_backend");
    expect(await backend.readFile("/workspace/src/app.ts")).toContain("value = 1");

    await expect(backend.exec("curl https://example.com")).rejects.toBeInstanceOf(
      SandboxPolicyError,
    );
    await expect(backend.exec("forbidden task")).rejects.toBeInstanceOf(SandboxPolicyError);
    await expect(backend.exec("echo too slow", { timeoutMs: 500 })).rejects.toBeInstanceOf(
      SandboxPolicyError,
    );

    await manager.disposeLease(lease);

    const restoredLease = {
      ...lease,
      leaseId: "lease_restored",
      snapshotId: "snap_backend",
    };
    expect(await manager.readFile(restoredLease, "/workspace/src/app.ts")).toContain("value = 1");
  });

  it("resolver routes filesystem and exec tools through sandbox backends", async () => {
    const registry = new StaticSandboxPlatformRegistry();
    registry.register(new InMemorySandboxPlatform());

    const manager = new DefaultSandboxManager({
      registry,
      snapshotStore: new InMemorySandboxSnapshotStore(),
    });

    const localBackend = {
      kind: "local",
      capabilities: () => ({
        exec: true,
        filesystemRead: true,
        filesystemWrite: true,
        network: true,
      }),
    };

    const resolver = new SandboxBackendResolver({
      manager,
      localBackend,
      buildLease: () => ({
        leaseId: "lease_from_resolver",
        platform: "memory",
        workspaceRoot: "/workspace",
      }),
    });

    const execTool: AgentTool = {
      name: "Bash",
      description: "Execute shell commands",
      schema: {} as any,
      capabilities: ["requires-exec"],
      invoke: async (): Promise<ToolResult> => ({ content: "ok" }),
    };

    const readTool: AgentTool = {
      name: "Read",
      description: "Read files",
      schema: {} as any,
      capabilities: ["requires-filesystem-read"],
      invoke: async (): Promise<ToolResult> => ({ content: "ok" }),
    };

    const safeTool: AgentTool = {
      name: "Brief",
      description: "Safe tool",
      schema: {} as any,
      invoke: async (): Promise<ToolResult> => ({ content: "ok" }),
    };

    const ctx = createRunContext();

    const execBackend = await resolver.resolve(ctx, execTool, {
      id: "tc_exec",
      name: "Bash",
      input: {},
    });
    const readBackend = await resolver.resolve(ctx, readTool, {
      id: "tc_read",
      name: "Read",
      input: {},
    });
    const safeBackend = await resolver.resolve(ctx, safeTool, {
      id: "tc_safe",
      name: "Brief",
      input: {},
    });

    expect(execBackend?.kind).toBe("sandbox");
    expect(readBackend?.kind).toBe("sandbox");
    expect(safeBackend).toBe(localBackend);
  });

  it("does not leak arbitrary host environment variables into local sandbox executions", async () => {
    const previous = process.env.RENX_SANDBOX_SECRET;
    process.env.RENX_SANDBOX_SECRET = "top-secret";

    const registry = new StaticSandboxPlatformRegistry();
    registry.register(new LocalSandboxPlatform());

    const manager = new DefaultSandboxManager({
      registry,
      snapshotStore: new InMemorySandboxSnapshotStore(),
    });

    const lease = {
      leaseId: "lease_local_env",
      platform: "local",
      workspaceRoot: process.cwd(),
      capabilities: await manager.capabilitiesFor({
        leaseId: "lease_local_env",
        platform: "local",
        workspaceRoot: process.cwd(),
      }),
    };
    const backend = new SandboxBackend({
      manager,
      lease,
    });

    try {
      const result = await backend.exec(
        "node -e \"process.stdout.write(process.env.RENX_SANDBOX_SECRET ?? '')\"",
      );
      expect(result.stdout).toBe("");
    } finally {
      if (previous === undefined) {
        delete process.env.RENX_SANDBOX_SECRET;
      } else {
        process.env.RENX_SANDBOX_SECRET = previous;
      }
      await manager.disposeLease(lease);
    }
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AgentRunContext, AgentTool, ToolResult } from "@renx/agent";
import type { ToolCall } from "@renx/model";
import {
  CallbackSandboxProvider,
  DefaultSandboxManager,
  InMemorySandboxLeaseStore,
  InMemorySandboxSnapshotStore,
  LocalSandboxPlatform,
  ManagedSandboxBackendResolver,
  SandboxFactory,
  SandboxLeaseJanitor,
} from "@renx/agent-sandbox";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const createRunContext = (runId: string): AgentRunContext => ({
  input: {
    messages: [
      {
        id: "msg_durable_1",
        messageId: "msg_durable_1",
        role: "user",
        content: "read the file",
        createdAt: new Date().toISOString(),
        source: "input",
      },
    ],
  },
  identity: { userId: "u1", tenantId: "t1", roles: [] },
  state: {
    runId,
    messages: [],
    scratchpad: {},
    memory: {},
    stepCount: 0,
    status: "running",
  },
  services: {},
  metadata: {},
});

const createManager = () =>
  new DefaultSandboxManager({
    registry: {
      register() {},
      get(kind) {
        return kind === "local" ? new LocalSandboxPlatform() : undefined;
      },
      list() {
        return [new LocalSandboxPlatform()];
      },
    },
    snapshotStore: new InMemorySandboxSnapshotStore(),
  });

const readTool: AgentTool = {
  name: "ReadSandboxFile",
  description: "Reads a file through sandbox backend",
  capabilities: ["requires-filesystem-read"],
  invoke: async (): Promise<ToolResult> => ({
    content: "ok",
  }),
};

const readCall: ToolCall = {
  id: "tc_1",
  name: "ReadSandboxFile",
  input: {},
};

describe("sandbox durable lifecycle", () => {
  it("reuses a persisted lease across resolver instances without reprovisioning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-sandbox-durable-"));
    tempDirs.push(dir);

    let provisionCount = 0;
    let releaseCount = 0;
    const store = new InMemorySandboxLeaseStore();
    const factory = new SandboxFactory({
      manager: createManager(),
    });
    factory.registerProvider(
      new CallbackSandboxProvider({
        kind: "local-provider",
        describe: () => ({
          kind: "local-provider",
          defaultWorkspaceRoot: dir,
          isolationMode: "host",
          supportsReconnect: true,
        }),
        provision: async (request) => {
          provisionCount += 1;
          return {
            leaseId: request.leaseId ?? "lease_durable",
            sandboxId: "sandbox_durable",
            platform: "local",
            workspaceRoot: request.workspaceRoot ?? dir,
          };
        },
        release: async () => {
          releaseCount += 1;
        },
      }),
    );

    const resolver1 = new ManagedSandboxBackendResolver({
      factory,
      provider: "local-provider",
      leaseStore: store,
      buildRequest: async () => ({
        workspaceRoot: dir,
        leaseId: "lease_durable",
      }),
    });
    const resolver2 = new ManagedSandboxBackendResolver({
      factory,
      provider: "local-provider",
      leaseStore: store,
      buildRequest: async () => ({
        workspaceRoot: dir,
        leaseId: "lease_durable",
      }),
    });

    const ctx = createRunContext("run_durable");
    const backend1 = await resolver1.resolve(ctx, readTool, readCall);
    const backend2 = await resolver2.resolve(ctx, readTool, readCall);

    expect(backend1?.kind).toBe("sandbox");
    expect(backend2?.kind).toBe("sandbox");
    expect(provisionCount).toBe(1);
    expect(await store.load("run_durable")).toMatchObject({
      runId: "run_durable",
      provider: "local-provider",
      lease: {
        leaseId: "lease_durable",
        sandboxId: "sandbox_durable",
      },
    });

    await resolver2.releaseRun("run_durable");
    expect(releaseCount).toBe(1);
    expect(await store.load("run_durable")).toBeUndefined();
  });

  it("cleans up stale orphaned leases from the durable store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-sandbox-janitor-"));
    tempDirs.push(dir);

    let releaseCount = 0;
    const store = new InMemorySandboxLeaseStore();
    const factory = new SandboxFactory({
      manager: createManager(),
    });
    factory.registerProvider(
      new CallbackSandboxProvider({
        kind: "local-provider",
        describe: () => ({
          kind: "local-provider",
          defaultWorkspaceRoot: dir,
          isolationMode: "host",
          supportsReconnect: true,
        }),
        provision: async (request) => ({
          leaseId: request.leaseId ?? "lease_janitor",
          sandboxId: "sandbox_janitor",
          platform: "local",
          workspaceRoot: request.workspaceRoot ?? dir,
        }),
        release: async () => {
          releaseCount += 1;
        },
      }),
    );

    await store.save({
      runId: "run_orphan",
      provider: "local-provider",
      lease: {
        leaseId: "lease_janitor",
        sandboxId: "sandbox_janitor",
        provider: "local-provider",
        platform: "local",
        workspaceRoot: dir,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
    });

    const janitor = new SandboxLeaseJanitor({
      factory,
      store,
      staleAfterMs: 60_000,
      now: () => new Date("2026-01-01T01:00:00.000Z"),
    });

    const report = await janitor.cleanupOrphans();
    expect(report).toMatchObject({
      released: 1,
      failed: 0,
    });
    expect(releaseCount).toBe(1);
    expect(await store.load("run_orphan")).toBeUndefined();
  });
});

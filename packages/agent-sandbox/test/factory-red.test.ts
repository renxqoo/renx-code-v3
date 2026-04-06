import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CallbackSandboxProvider,
  DefaultSandboxManager,
  InMemorySandboxSnapshotStore,
  LocalSandboxPlatform,
  ManagedSandboxBackendResolver,
  SandboxFactory,
  createSandboxAgentIntegration,
} from "@renx/agent-sandbox";
import { AgentRuntime, MiddlewarePipeline, createDeepAgent } from "@renx/agent";
import type { AgentRunContext, AgentTool, ToolResult } from "@renx/agent";
import type { ModelClient, ModelResponse } from "@renx/model";
import type { ToolCall } from "@renx/model";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const createRunContext = (): AgentRunContext => ({
  input: {
    messages: [
      {
        id: "msg_sandbox_1",
        messageId: "msg_sandbox_1",
        role: "user",
        content: "read the file",
        createdAt: new Date().toISOString(),
        source: "input",
      },
    ],
  },
  identity: { userId: "u1", tenantId: "t1", roles: [] },
  state: {
    runId: "run_factory",
    messages: [],
    scratchpad: {},
    memory: {},
    stepCount: 0,
    status: "running",
  },
  services: {},
  metadata: {},
});

const createMockModelClient = (responses: Array<ModelResponse | Error>): ModelClient => {
  let index = 0;
  return {
    generate: async () => {
      const response = responses[index++] ?? { type: "final", output: "done" };
      if (response instanceof Error) {
        throw response;
      }
      return response;
    },
    async *stream() {
      yield { type: "done" as const };
    },
    resolve: () => ({
      logicalModel: "test",
      provider: "test",
      providerModel: "test",
    }),
  };
};

describe("sandbox factory and managed resolver", () => {
  it("rejects backend creation for leases that have not completed capability negotiation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-sandbox-unnegotiated-"));
    tempDirs.push(dir);

    const manager = new DefaultSandboxManager({
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

    const factory = new SandboxFactory({ manager });

    expect(() =>
      factory.createBackend({
        leaseId: "lease_unnegotiated",
        provider: "local-provider",
        platform: "local",
        workspaceRoot: dir,
      }),
    ).toThrow(/capabilities/i);
  });

  it("initializes providers only once across multiple provisions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-sandbox-init-"));
    tempDirs.push(dir);

    const manager = new DefaultSandboxManager({
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

    let initializeCount = 0;
    const factory = new SandboxFactory({ manager });
    factory.registerProvider(
      new CallbackSandboxProvider({
        kind: "local-provider",
        initialize: async () => {
          initializeCount += 1;
        },
        provision: async (request) => ({
          leaseId: request.leaseId ?? "lease_init",
          platform: "local",
          workspaceRoot: request.workspaceRoot ?? dir,
        }),
      }),
    );

    await factory.provision({
      provider: "local-provider",
      workspaceRoot: dir,
      leaseId: "lease_init_1",
    });
    await factory.provision({
      provider: "local-provider",
      workspaceRoot: dir,
      leaseId: "lease_init_2",
    });

    expect(initializeCount).toBe(1);
  });

  it("runs provider prepare against the provisioned backend before returning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-sandbox-prepare-"));
    tempDirs.push(dir);

    const manager = new DefaultSandboxManager({
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

    let prepareCount = 0;
    const factory = new SandboxFactory({ manager });
    factory.registerProvider(
      new CallbackSandboxProvider({
        kind: "local-provider",
        provision: async (request) => ({
          leaseId: request.leaseId ?? "lease_prepare",
          platform: "local",
          workspaceRoot: request.workspaceRoot ?? dir,
        }),
        prepare: async (_lease, backend) => {
          prepareCount += 1;
          await backend.writeFile(join(dir, "bootstrap.txt"), "prepared sandbox");
        },
      }),
    );

    const lease = await factory.provision({
      provider: "local-provider",
      workspaceRoot: dir,
      leaseId: "lease_prepare",
    });
    const backend = factory.createBackend(lease);

    expect(await backend.readFile(join(dir, "bootstrap.txt"))).toBe("prepared sandbox");
    expect(prepareCount).toBe(1);
  });

  it("releases provisioned leases when provider prepare fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-sandbox-prepare-fail-"));
    tempDirs.push(dir);

    const manager = new DefaultSandboxManager({
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

    let releaseCount = 0;
    const factory = new SandboxFactory({ manager });
    factory.registerProvider(
      new CallbackSandboxProvider({
        kind: "local-provider",
        provision: async (request) => ({
          leaseId: request.leaseId ?? "lease_prepare_fail",
          platform: "local",
          workspaceRoot: request.workspaceRoot ?? dir,
        }),
        prepare: async () => {
          throw new Error("prepare failed");
        },
        release: async () => {
          releaseCount += 1;
        },
      }),
    );

    await expect(
      factory.provision({
        provider: "local-provider",
        workspaceRoot: dir,
        leaseId: "lease_prepare_fail",
      }),
    ).rejects.toThrow("prepare failed");
    expect(releaseCount).toBe(1);
  });

  it("provisions and releases leases through providers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-sandbox-factory-"));
    tempDirs.push(dir);

    const manager = new DefaultSandboxManager({
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

    const released: string[] = [];
    const factory = new SandboxFactory({ manager });
    factory.registerProvider(
      new CallbackSandboxProvider({
        kind: "local-provider",
        provision: async (request) => ({
          leaseId: request.leaseId ?? "lease_factory",
          platform: "local",
          workspaceRoot: request.workspaceRoot ?? dir,
        }),
        release: async (lease) => {
          released.push(lease.leaseId);
        },
      }),
    );

    const lease = await factory.provision({
      provider: "local-provider",
      workspaceRoot: dir,
      leaseId: "lease_factory",
    });
    const backend = factory.createBackend(lease);

    await backend.writeFile(join(dir, "hello.txt"), "hello sandbox");
    expect(await backend.readFile(join(dir, "hello.txt"))).toBe("hello sandbox");

    await factory.release(lease);
    expect(released).toEqual(["lease_factory"]);
  });

  it("managed resolver provisions once per run and lifecycle integration releases after runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-sandbox-runtime-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", "note.txt"), "runtime sandbox content\n", "utf8");

    const manager = new DefaultSandboxManager({
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

    let provisionCount = 0;
    let releaseCount = 0;
    const factory = new SandboxFactory({ manager });
    factory.registerProvider(
      new CallbackSandboxProvider({
        kind: "local-provider",
        provision: async (request) => {
          provisionCount += 1;
          return {
            leaseId: request.leaseId ?? "lease_runtime",
            platform: "local",
            workspaceRoot: request.workspaceRoot ?? dir,
          };
        },
        release: async () => {
          releaseCount += 1;
        },
      }),
    );

    const integration = createSandboxAgentIntegration({
      factory,
      provider: "local-provider",
      buildRequest: async () => ({
        workspaceRoot: dir,
        leaseId: "lease_runtime",
      }),
    });

    const readTool: AgentTool = {
      name: "ReadSandboxFile",
      description: "Reads a file through sandbox backend",
      schema: {} as any,
      capabilities: ["requires-filesystem-read"],
      invoke: async (_input, ctx): Promise<ToolResult> => ({
        content: await ctx.backend!.readFile!(join(dir, "docs", "note.txt")),
      }),
    };

    const modelClient = createMockModelClient([
      {
        type: "tool_calls",
        toolCalls: [
          {
            id: "tc_1",
            name: "ReadSandboxFile",
            input: {},
          } as ToolCall,
        ],
      },
      { type: "final", output: "done" },
    ]);

    const runtime = new AgentRuntime({
      name: "sandbox-runtime",
      modelClient,
      model: "test-model",
      tools: [readTool],
      systemPrompt: "Use tools when needed.",
      maxSteps: 4,
      backendResolver: integration.backend,
      pipeline: new MiddlewarePipeline(integration.middleware),
    });

    const result = await runtime.run(createRunContext());
    expect(result.status).toBe("completed");
    expect(result.state.lastToolResult?.content).toContain("runtime sandbox content");
    expect(provisionCount).toBe(1);
    expect(releaseCount).toBe(1);
  });

  it("releases the sandbox lease even when runtime fails after tool execution", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-sandbox-runtime-fail-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", "note.txt"), "runtime sandbox content\n", "utf8");

    const manager = new DefaultSandboxManager({
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

    let releaseCount = 0;
    const factory = new SandboxFactory({ manager });
    factory.registerProvider(
      new CallbackSandboxProvider({
        kind: "local-provider",
        provision: async (request) => ({
          leaseId: request.leaseId ?? "lease_runtime_fail",
          platform: "local",
          workspaceRoot: request.workspaceRoot ?? dir,
        }),
        release: async () => {
          releaseCount += 1;
        },
      }),
    );

    const integration = createSandboxAgentIntegration({
      factory,
      provider: "local-provider",
      buildRequest: async () => ({
        workspaceRoot: dir,
        leaseId: "lease_runtime_fail",
      }),
    });

    const readTool: AgentTool = {
      name: "ReadSandboxFile",
      description: "Reads a file through sandbox backend",
      capabilities: ["requires-filesystem-read"],
      invoke: async (_input, ctx): Promise<ToolResult> => ({
        content: await ctx.backend!.readFile!(join(dir, "docs", "note.txt")),
      }),
    };

    const runtime = new AgentRuntime({
      name: "sandbox-runtime-fail",
      modelClient: createMockModelClient([
        {
          type: "tool_calls",
          toolCalls: [
            {
              id: "tc_1",
              name: "ReadSandboxFile",
              input: {},
            } as ToolCall,
          ],
        },
        new Error("model crashed after tool"),
      ]),
      model: "test-model",
      tools: [readTool],
      systemPrompt: "Use tools when needed.",
      maxSteps: 4,
      backendResolver: integration.backend,
      pipeline: new MiddlewarePipeline(integration.middleware),
    });

    const result = await runtime.run(createRunContext());
    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("model crashed after tool");
    expect(releaseCount).toBe(1);
  });

  it("plugs sandbox integration directly into createDeepAgent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-sandbox-harness-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", "note.txt"), "preset sandbox content\n", "utf8");

    const manager = new DefaultSandboxManager({
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

    let releaseCount = 0;
    const factory = new SandboxFactory({ manager });
    factory.registerProvider(
      new CallbackSandboxProvider({
        kind: "local-provider",
        provision: async (request) => ({
          leaseId: request.leaseId ?? "lease_harness_preset",
          platform: "local",
          workspaceRoot: request.workspaceRoot ?? dir,
        }),
        release: async () => {
          releaseCount += 1;
        },
      }),
    );

    const readTool: AgentTool = {
      name: "ReadSandboxFile",
      description: "Reads a file through sandbox backend",
      schema: {} as any,
      capabilities: ["requires-filesystem-read"],
      invoke: async (_input, ctx): Promise<ToolResult> => ({
        content: await ctx.backend!.readFile!(join(dir, "docs", "note.txt")),
      }),
    };

    const integration = createSandboxAgentIntegration({
      factory,
      provider: "local-provider",
      buildRequest: async () => ({
        workspaceRoot: dir,
        leaseId: "lease_harness_preset",
      }),
    });

    const agent = createDeepAgent({
      model: {
        client: createMockModelClient([
          {
            type: "tool_calls",
            toolCalls: [{ id: "tc_1", name: "ReadSandboxFile", input: {} } as ToolCall],
          },
          { type: "final", output: "done" },
        ]),
        name: "test-model",
      },
      systemPrompt: "Use the sandbox preset.",
      backend: integration.backend,
      middleware: integration.middleware,
      tools: [readTool],
    });

    const result = await agent.invoke(createRunContext().input);
    expect(result.status).toBe("completed");
    expect(result.state.lastToolResult?.content).toContain("preset sandbox content");
    expect(releaseCount).toBe(1);
  });
});

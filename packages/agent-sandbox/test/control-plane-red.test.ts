import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CallbackSandboxProvider,
  DefaultSandboxManager,
  InMemorySandboxSnapshotStore,
  LocalSandboxPlatform,
  SandboxFactory,
  SandboxProviderError,
} from "@renx/agent-sandbox";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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

describe("sandbox provider control plane", () => {
  it("applies provider defaults, verifies dependencies once, polls readiness, and negotiates backend capabilities", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-sandbox-control-"));
    tempDirs.push(dir);

    let dependencyChecks = 0;
    let readinessChecks = 0;
    let observedWorkspaceRoot: string | undefined;

    const factory = new SandboxFactory({
      manager: createManager(),
      defaultReadinessTimeoutMs: 200,
      defaultReadinessIntervalMs: 1,
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
        verifyDependencies: async () => {
          dependencyChecks += 1;
          return { ok: true, issues: [] };
        },
        provision: async (request) => {
          observedWorkspaceRoot = request.workspaceRoot;
          return {
            leaseId: request.leaseId ?? "lease_control",
            platform: "local",
            workspaceRoot: request.workspaceRoot ?? dir,
          };
        },
        isReady: async () => {
          readinessChecks += 1;
          return readinessChecks >= 3;
        },
      }),
    );

    const firstLease = await factory.provision({
      provider: "local-provider",
      leaseId: "lease_control",
    });
    const secondLease = await factory.provision({
      provider: "local-provider",
      leaseId: "lease_control_2",
    });

    expect(observedWorkspaceRoot).toBe(dir);
    expect(dependencyChecks).toBe(1);
    expect(readinessChecks).toBe(4);
    expect(firstLease.provider).toBe("local-provider");
    expect(firstLease.capabilities).toMatchObject({
      filesystemRead: true,
      filesystemWrite: true,
      persistentSession: true,
      pathMetadata: true,
      snapshots: true,
      network: true,
    });
    expect(factory.createBackend(firstLease).capabilities()).toMatchObject({
      network: true,
    });
    expect(secondLease.provider).toBe("local-provider");
  });

  it("fails before provision when provider dependency verification reports missing requirements", async () => {
    let provisionCalled = false;

    const factory = new SandboxFactory({
      manager: createManager(),
    });
    factory.registerProvider(
      new CallbackSandboxProvider({
        kind: "broken-provider",
        verifyDependencies: async () => ({
          ok: false,
          issues: ["missing sandbox SDK credentials"],
        }),
        provision: async () => {
          provisionCalled = true;
          return {
            leaseId: "lease_broken",
            platform: "local",
            workspaceRoot: process.cwd(),
          };
        },
      }),
    );

    await expect(
      factory.provision({
        provider: "broken-provider",
      }),
    ).rejects.toBeInstanceOf(SandboxProviderError);
    expect(provisionCalled).toBe(false);
  });

  it("fails fast when provider readiness never becomes healthy within the timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-sandbox-control-timeout-"));
    tempDirs.push(dir);

    const factory = new SandboxFactory({
      manager: createManager(),
      defaultReadinessTimeoutMs: 20,
      defaultReadinessIntervalMs: 1,
    });
    factory.registerProvider(
      new CallbackSandboxProvider({
        kind: "timing-out-provider",
        describe: () => ({
          kind: "timing-out-provider",
          defaultWorkspaceRoot: dir,
          isolationMode: "remote",
          supportsReconnect: true,
        }),
        provision: async (request) => ({
          leaseId: request.leaseId ?? "lease_timeout",
          platform: "local",
          workspaceRoot: request.workspaceRoot ?? dir,
        }),
        isReady: async () => false,
      }),
    );

    await expect(
      factory.provision({
        provider: "timing-out-provider",
        leaseId: "lease_timeout",
      }),
    ).rejects.toThrow(/readiness/i);
  });
});

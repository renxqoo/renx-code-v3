import { describe, expect, it } from "vitest";

import {
  DefaultSandboxManager,
  InMemorySandboxLeaseStore,
  InMemorySandboxSnapshotStore,
  LocalSandboxPlatform,
  LocalSandboxProvider,
  SandboxDoctor,
  SandboxFactory,
} from "@renx/agent-sandbox";

describe("sandbox doctor", () => {
  it("reports provider health, active leases, durable leases, and unsafe host-backed warnings", async () => {
    const store = new InMemorySandboxLeaseStore();
    const factory = new SandboxFactory({
      manager: new DefaultSandboxManager({
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
      }),
    });
    factory.registerProvider(new LocalSandboxProvider());

    const lease = await factory.provision({
      provider: "local",
      leaseId: "lease_doctor",
    });
    await store.save({
      runId: "run_doctor",
      provider: "local",
      lease,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:10.000Z",
    });

    const doctor = new SandboxDoctor({
      factory,
      leaseStore: store,
    });
    const report = await doctor.inspect();

    expect(report.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "local",
          dependencyStatus: "ready",
          defaultWorkspaceRoot: expect.any(String),
          isolationMode: "host",
          supportsReconnect: true,
        }),
      ]),
    );
    expect(report.activeLeases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          leaseId: "lease_doctor",
          provider: "local",
          platform: "local",
        }),
      ]),
    );
    expect(report.durableLeases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run_doctor",
          provider: "local",
          leaseId: "lease_doctor",
        }),
      ]),
    );
    expect(report.warnings.join("\n")).toMatch(/host-backed|non-isolated|local sandbox/i);
  });
});

import { describe, expect, it } from "vitest";

import {
  createMemorySnapshot,
  createMemoryTeamSyncState,
  InMemoryMemoryRemoteTransport,
  InMemoryScopedMemoryStore,
  MemoryTeamSyncService,
} from "../../src/memory";

describe("memory team sync", () => {
  it("pulls a remote scoped snapshot into local memory and tracks remote hashes", async () => {
    const scopedStore = new InMemoryScopedMemoryStore();
    const remote = new InMemoryMemoryRemoteTransport();
    const syncState = createMemoryTeamSyncState();
    const service = new MemoryTeamSyncService(scopedStore, remote);

    await remote.replace(
      "project",
      "tenant-a/repo-a",
      createMemorySnapshot({
        working: {
          skills: [
            {
              name: "repo-skill",
              content: "Prefer integration tests over mocks.",
              updatedAt: "2026-04-05T00:00:00.000Z",
              scope: "project",
            },
          ],
        },
        semantic: {
          entries: [
            {
              id: "project:testing-policy",
              type: "project",
              content: "Use pnpm and integration tests.",
              updatedAt: "2026-04-05T01:00:00.000Z",
              scope: "project",
            },
          ],
        },
      }),
    );

    const result = await service.pull({
      scope: "project",
      namespace: "tenant-a/repo-a",
      state: syncState,
    });

    expect(result.status).toBe("updated");
    expect(result.entryCount).toBe(2);
    expect(syncState.lastKnownChecksum).toBeTruthy();
    expect(Object.keys(syncState.serverChecksums).length).toBe(2);

    const localSnapshot = createMemorySnapshot(
      (await scopedStore.load("project", "tenant-a/repo-a")) ?? undefined,
    );
    expect(localSnapshot.semantic.entries[0]?.content).toContain("Use pnpm");
    expect(localSnapshot.working.skills[0]?.content).toContain("integration tests");
  });

  it("retries conflicted pushes, skips secret-bearing entries, and keeps local wins semantics", async () => {
    const scopedStore = new InMemoryScopedMemoryStore();
    const remote = new InMemoryMemoryRemoteTransport();
    const syncState = createMemoryTeamSyncState();
    const service = new MemoryTeamSyncService(scopedStore, remote, {
      maxConflictRetries: 2,
    });

    await remote.replace(
      "project",
      "tenant-a/repo-a",
      createMemorySnapshot({
        semantic: {
          entries: [
            {
              id: "project:testing-policy",
              type: "project",
              content: "Use npm and unit mocks.",
              updatedAt: "2026-04-05T00:00:00.000Z",
              scope: "project",
            },
          ],
        },
      }),
    );

    await service.pull({
      scope: "project",
      namespace: "tenant-a/repo-a",
      state: syncState,
    });

    await scopedStore.save(
      "project",
      "tenant-a/repo-a",
      createMemorySnapshot({
        semantic: {
          entries: [
            {
              id: "project:testing-policy",
              type: "project",
              content: "Use pnpm and integration tests.",
              updatedAt: "2026-04-05T02:00:00.000Z",
              scope: "project",
            },
            {
              id: "project:secret",
              type: "project",
              content:
                "Temporary token OPENAI_TEST_TOKEN_REDACTED_FOR_PUSH_PROTECTION",
              updatedAt: "2026-04-05T02:05:00.000Z",
              scope: "project",
            },
          ],
        },
      }),
    );

    remote.injectConflictOnce((snapshot) =>
      createMemorySnapshot({
        ...snapshot,
        semantic: {
          entries: [
            {
              id: "project:testing-policy",
              type: "project",
              content: "Run eslint before commit.",
              updatedAt: "2026-04-05T02:03:00.000Z",
              scope: "project",
            },
          ],
        },
      }),
    );

    const result = await service.push({
      scope: "project",
      namespace: "tenant-a/repo-a",
      state: syncState,
    });

    expect(result.status).toBe("synced");
    expect(result.uploadedEntryCount).toBe(1);
    expect(result.skippedSecretEntryKeys).toEqual(["semantic/project:secret"]);

    const remoteSnapshot = createMemorySnapshot(
      await remote.loadSnapshot("project", "tenant-a/repo-a"),
    );
    expect(remoteSnapshot.semantic.entries.map((entry) => entry.id)).toEqual([
      "project:testing-policy",
    ]);
    expect(remoteSnapshot.semantic.entries[0]?.content).toContain("Use pnpm");
  });
});

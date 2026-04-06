import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SESSION_MEMORY_TEMPLATE,
  createSessionMemoryRecord,
} from "../../src/context/session-memory";
import {
  FileSessionMemoryStore,
  InMemorySessionMemoryStore,
} from "../../src/context/session-memory-store";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (!target) continue;
    await rm(target, { recursive: true, force: true });
  }
});

describe("session memory store", () => {
  it("keeps records in memory for tests", async () => {
    const store = new InMemorySessionMemoryStore();
    const record = {
      ...createSessionMemoryRecord(),
      notes: `${DEFAULT_SESSION_MEMORY_TEMPLATE}\nCurrent task: repair compact boundary handling.`,
      lastSummarizedMessageId: "m_9",
    };

    await store.save("run_in_memory", record);

    await expect(store.load("run_in_memory")).resolves.toEqual(record);
  });

  it("persists notes.md and state.json to disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "renx-session-memory-"));
    cleanupPaths.push(root);

    const store = new FileSessionMemoryStore(root);
    const record = {
      ...createSessionMemoryRecord(),
      notes: `${DEFAULT_SESSION_MEMORY_TEMPLATE}\nImplemented session-memory extraction.`,
      initialized: true,
      lastSummarizedMessageId: "m_12",
      tokensAtLastExtraction: 321,
    };

    await store.save("run_file_store", record);

    const loaded = await store.load("run_file_store");
    const notesPath = join(root, "run_file_store", "notes.md");
    const statePath = join(root, "run_file_store", "state.json");

    expect(loaded).toEqual(record);
    await expect(readFile(notesPath, "utf-8")).resolves.toContain(
      "Implemented session-memory extraction.",
    );
    await expect(readFile(statePath, "utf-8")).resolves.toContain(
      '"lastSummarizedMessageId": "m_12"',
    );
  });

  it("reconstructs default state when notes.md exists but state.json is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "renx-session-memory-"));
    cleanupPaths.push(root);

    const store = new FileSessionMemoryStore(root);
    const runDir = join(root, "run_recover_defaults");
    await store.save("run_recover_defaults", {
      ...createSessionMemoryRecord(),
      notes: `${DEFAULT_SESSION_MEMORY_TEMPLATE}\nRecovered notes body.`,
      initialized: true,
      tokensAtLastExtraction: 222,
    });
    await rm(join(runDir, "state.json"), { force: true });

    const loaded = await store.load("run_recover_defaults");

    expect(loaded).toEqual({
      ...createSessionMemoryRecord(),
      notes: `${DEFAULT_SESSION_MEMORY_TEMPLATE}\nRecovered notes body.`,
    });
  });
});

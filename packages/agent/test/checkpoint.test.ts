import { describe, expect, it } from "vitest";

import type { AgentState } from "../src/types";
import { InMemoryCheckpointStore } from "../src/checkpoint";

const state: AgentState = {
  runId: "run_1",
  messages: [],
  scratchpad: {},
  memory: {},
  stepCount: 0,
  status: "running",
};

const now = new Date().toISOString();

describe("InMemoryCheckpointStore", () => {
  it("saves and loads a checkpoint", async () => {
    const store = new InMemoryCheckpointStore();
    const record = {
      runId: "run_1",
      state,
      createdAt: now,
      updatedAt: now,
    };

    await store.save(record);
    const loaded = await store.load("run_1");

    expect(loaded).toEqual(record);
  });

  it("returns null for unknown runId", async () => {
    const store = new InMemoryCheckpointStore();
    const loaded = await store.load("nonexistent");
    expect(loaded).toBeNull();
  });

  it("updates existing checkpoint on re-save", async () => {
    const store = new InMemoryCheckpointStore();

    await store.save({
      runId: "run_1",
      state: { ...state, stepCount: 0 },
      createdAt: now,
      updatedAt: now,
    });

    await store.save({
      runId: "run_1",
      state: { ...state, stepCount: 5, status: "completed" },
      createdAt: now,
      updatedAt: now,
    });

    const loaded = await store.load("run_1");
    expect(loaded!.state.stepCount).toBe(5);
    expect(loaded!.state.status).toBe("completed");
  });

  it("deletes a checkpoint", async () => {
    const store = new InMemoryCheckpointStore();
    await store.save({ runId: "run_1", state, createdAt: now, updatedAt: now });
    await store.delete("run_1");
    expect(await store.load("run_1")).toBeNull();
  });
});

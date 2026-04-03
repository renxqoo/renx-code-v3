import { describe, expect, it } from "vitest";

import type { AgentState } from "../src/types";
import { InMemoryTimelineStore } from "../src/timeline";

const state: AgentState = {
  runId: "run_1",
  messages: [],
  scratchpad: {},
  memory: {},
  stepCount: 0,
  status: "running",
};

const now = new Date().toISOString();

describe("InMemoryTimelineStore", () => {
  it("saves and loads a timeline snapshot", async () => {
    const store = new InMemoryTimelineStore();
    const record = {
      nodeId: "node_1",
      runId: "run_1",
      state,
      version: 0,
      createdAt: now,
      updatedAt: now,
    };

    const savedVersion = await store.save(record);
    const loaded = await store.load("run_1");

    expect(savedVersion).toBe(1);
    expect(loaded).toEqual({ ...record, version: 1 });
  });

  it("returns null for unknown runId", async () => {
    const store = new InMemoryTimelineStore();
    const loaded = await store.load("nonexistent");
    expect(loaded).toBeNull();
  });

  it("updates existing snapshot on re-save", async () => {
    const store = new InMemoryTimelineStore();

    await store.save({
      nodeId: "node_1",
      runId: "run_1",
      state: { ...state, stepCount: 0 },
      version: 0,
      createdAt: now,
      updatedAt: now,
    });

    await store.save({
      nodeId: "node_2",
      parentNodeId: "node_1",
      runId: "run_1",
      state: { ...state, stepCount: 5, status: "completed" },
      version: 0,
      createdAt: now,
      updatedAt: now,
    });

    const loaded = await store.load("run_1");
    expect(loaded!.state.stepCount).toBe(5);
    expect(loaded!.state.status).toBe("completed");
  });

  it("deletes a snapshot", async () => {
    const store = new InMemoryTimelineStore();
    await store.save({
      nodeId: "node_1",
      runId: "run_1",
      state,
      version: 0,
      createdAt: now,
      updatedAt: now,
    });
    await store.delete("run_1");
    expect(await store.load("run_1")).toBeNull();
  });

  it("loads specific node and lists nodes in version order", async () => {
    const store = new InMemoryTimelineStore();
    await store.save({
      nodeId: "node_1",
      runId: "run_1",
      state: { ...state, stepCount: 1 },
      version: 0,
      createdAt: now,
      updatedAt: now,
    });
    await store.save({
      nodeId: "node_2",
      parentNodeId: "node_1",
      runId: "run_1",
      state: { ...state, stepCount: 2 },
      version: 0,
      createdAt: now,
      updatedAt: now,
    });

    const node1 = await store.loadNode("run_1", "node_1");
    const nodes = await store.listNodes("run_1");
    expect(node1?.state.stepCount).toBe(1);
    expect(nodes.map((node) => node.nodeId)).toEqual(["node_1", "node_2"]);
  });
});

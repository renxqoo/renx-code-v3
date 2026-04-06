import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FileTimelineStore } from "../../src";
import type { TimelineNode } from "../../src";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const createNode = (overrides?: Partial<TimelineNode>): TimelineNode => ({
  nodeId: overrides?.nodeId ?? "node_1",
  ...(overrides?.parentNodeId ? { parentNodeId: overrides.parentNodeId } : {}),
  runId: overrides?.runId ?? "run_1",
  state: overrides?.state ?? {
    runId: "run_1",
    messages: [],
    scratchpad: {},
    memory: {},
    stepCount: 0,
    status: "running",
  },
  version: overrides?.version ?? 0,
  ...(overrides?.metadata ? { metadata: overrides.metadata } : {}),
  createdAt: overrides?.createdAt ?? "2026-04-06T00:00:00.000Z",
  updatedAt: overrides?.updatedAt ?? "2026-04-06T00:00:00.000Z",
});

describe("FileTimelineStore", () => {
  it("persists timeline nodes across store instances and returns the latest head", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-timeline-store-"));
    tempDirs.push(dir);

    const store = new FileTimelineStore(dir);
    await store.save(createNode({ nodeId: "node_1" }));
    await store.save(
      createNode({
        nodeId: "node_2",
        parentNodeId: "node_1",
        state: {
          runId: "run_1",
          messages: [
            {
              id: "msg_1",
              messageId: "msg_1",
              role: "user",
              content: "continue the work",
              createdAt: "2026-04-06T00:00:00.000Z",
              source: "input",
            },
          ],
          scratchpad: {},
          memory: {},
          stepCount: 1,
          status: "running",
        },
      }),
      1,
    );

    const reopened = new FileTimelineStore(dir);
    const head = await reopened.load("run_1");
    const nodes = await reopened.listNodes("run_1");

    expect(head?.nodeId).toBe("node_2");
    expect(head?.version).toBe(2);
    expect(head?.state.messages).toHaveLength(1);
    expect(nodes.map((node) => `${node.nodeId}:${node.version}`)).toEqual(["node_1:1", "node_2:2"]);
  });

  it("deletes persisted runs cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-timeline-store-"));
    tempDirs.push(dir);

    const store = new FileTimelineStore(dir);
    await store.save(createNode());
    await store.delete("run_1");

    expect(await store.load("run_1")).toBeNull();
    expect(await store.listNodes("run_1")).toEqual([]);
  });
});

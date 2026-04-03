import type { TimelineNode, TimelineStore } from "../types";

import { TimelineVersionConflictError } from "./errors";
import { TIMELINE_INTERNAL_MODE_FORK, TIMELINE_INTERNAL_MODE_KEY } from "./constants";

export class InMemoryTimelineStore implements TimelineStore {
  private readonly nodesByRun = new Map<string, Map<string, TimelineNode>>();
  private readonly headByRun = new Map<string, string>();

  async load(runId: string): Promise<TimelineNode | null> {
    const headId = this.headByRun.get(runId);
    if (!headId) return null;
    return this.nodesByRun.get(runId)?.get(headId) ?? null;
  }

  async loadNode(runId: string, nodeId: string): Promise<TimelineNode | null> {
    return this.nodesByRun.get(runId)?.get(nodeId) ?? null;
  }

  async listNodes(runId: string): Promise<TimelineNode[]> {
    const nodes = Array.from(this.nodesByRun.get(runId)?.values() ?? []);
    nodes.sort((a, b) => a.version - b.version);
    return nodes;
  }

  async save(node: TimelineNode, expectedVersion?: number): Promise<number> {
    const currentHeadId = this.headByRun.get(node.runId);
    const current = currentHeadId
      ? (this.nodesByRun.get(node.runId)?.get(currentHeadId) ?? null)
      : null;
    const isForkAppend =
      node.metadata?.[TIMELINE_INTERNAL_MODE_KEY] === TIMELINE_INTERNAL_MODE_FORK &&
      node.parentNodeId !== undefined &&
      node.parentNodeId !== currentHeadId;
    const parent =
      isForkAppend && node.parentNodeId !== undefined
        ? (this.nodesByRun.get(node.runId)?.get(node.parentNodeId) ?? null)
        : current;
    const expectedActualVersion = parent?.version;
    if (expectedVersion !== undefined && expectedActualVersion !== expectedVersion) {
      throw new TimelineVersionConflictError(
        `Expected timeline version ${expectedVersion}, got ${expectedActualVersion ?? "none"}`,
      );
    }

    const nextVersion = (current?.version ?? 0) + 1;
    const nodes = this.nodesByRun.get(node.runId) ?? new Map<string, TimelineNode>();
    nodes.set(node.nodeId, { ...node, version: nextVersion });
    this.nodesByRun.set(node.runId, nodes);
    this.headByRun.set(node.runId, node.nodeId);
    return nextVersion;
  }

  async delete(runId: string): Promise<void> {
    this.nodesByRun.delete(runId);
    this.headByRun.delete(runId);
  }
}

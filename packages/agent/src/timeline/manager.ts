import { generateId } from "../helpers";
import type { AgentState, TimelineNode, TimelineStore } from "../types";

import { TimelineVersionConflictError } from "./errors";
import { TIMELINE_INTERNAL_MODE_FORK, TIMELINE_INTERNAL_MODE_KEY } from "./constants";

export class TimelineManager {
  private version: number | undefined;
  private headNodeId: string | undefined;
  private readonly mode: "default" | "fork" | "fast_forward" | "read_only_preview";
  private nextParentNodeId: string | undefined;

  constructor(
    private readonly store?: TimelineStore,
    options?: {
      mode?: "default" | "fork" | "fast_forward" | "read_only_preview";
      parentNodeId?: string;
    },
  ) {
    this.mode = options?.mode ?? "default";
    this.nextParentNodeId = options?.parentNodeId;
  }

  async load(runId: string): Promise<TimelineNode | null> {
    if (!this.store) return null;
    return this.store.load(runId);
  }

  async loadNode(runId: string, nodeId: string): Promise<TimelineNode | null> {
    if (!this.store) return null;
    return this.store.loadNode(runId, nodeId);
  }

  async listNodes(runId: string): Promise<TimelineNode[]> {
    if (!this.store) return [];
    return this.store.listNodes(runId);
  }

  async save(runId: string, state: AgentState): Promise<void> {
    if (!this.store) return;
    if (this.mode === "read_only_preview") return;
    await this.ensureMeta(runId);
    const now = new Date().toISOString();
    const nodeId = generateId("node");
    const parentNodeId = this.nextParentNodeId ?? this.headNodeId;
    const expectedVersion = await this.resolveExpectedVersion(runId, parentNodeId);

    try {
      const metadata =
        this.mode === "fork" && parentNodeId && parentNodeId !== this.headNodeId
          ? { [TIMELINE_INTERNAL_MODE_KEY]: TIMELINE_INTERNAL_MODE_FORK }
          : undefined;
      const nextVersion = await this.store.save(
        {
          nodeId,
          ...(parentNodeId ? { parentNodeId } : {}),
          runId,
          state,
          version: this.version ?? 0,
          ...(metadata ? { metadata } : {}),
          createdAt: now,
          updatedAt: now,
        },
        expectedVersion,
      );
      this.version = nextVersion;
      this.headNodeId = nodeId;
      this.nextParentNodeId = undefined;
      return;
    } catch (error) {
      if (!(error instanceof TimelineVersionConflictError)) throw error;
    }

    const latest = await this.store.load(runId);
    if (!latest) return;
    this.version = latest.version;
    this.headNodeId = latest.nodeId;
  }

  async casUpdate(
    runId: string,
    apply: (current: TimelineNode) => AgentState | null,
  ): Promise<"updated" | "conflict" | "missing"> {
    if (!this.store) return "missing";
    const current = await this.store.load(runId);
    if (!current) return "missing";
    const nextState = apply(current);
    if (!nextState) return "missing";
    const nodeId = generateId("node");

    try {
      const nextVersion = await this.store.save(
        {
          nodeId,
          parentNodeId: current.nodeId,
          runId: current.runId,
          state: nextState,
          version: 0,
          ...(current.metadata ? { metadata: current.metadata } : {}),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        current.version,
      );
      this.version = nextVersion;
      this.headNodeId = nodeId;
      return "updated";
    } catch (error) {
      if (error instanceof TimelineVersionConflictError) return "conflict";
      throw error;
    }
  }

  private async ensureMeta(runId: string): Promise<void> {
    if (!this.store) return;
    if (this.version !== undefined) return;
    const existing = await this.store.load(runId);
    if (!existing) return;
    this.version = existing.version;
    this.headNodeId = existing.nodeId;
  }

  private async resolveExpectedVersion(
    runId: string,
    parentNodeId: string | undefined,
  ): Promise<number | undefined> {
    if (!this.store) return undefined;
    if (this.mode !== "fork") return this.version;
    if (!parentNodeId) return this.version;
    if (parentNodeId === this.headNodeId) return this.version;
    const parent = await this.store.loadNode(runId, parentNodeId);
    return parent?.version;
  }
}

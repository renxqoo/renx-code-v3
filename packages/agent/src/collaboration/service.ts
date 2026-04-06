import type { BlackboardStore } from "./blackboard";

export type CollaborationNodeStatus =
  | "pending"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface CollaborationTaskNode {
  id: string;
  title: string;
  objective: string;
  dependsOn?: string[];
  status?: CollaborationNodeStatus;
  result?: Record<string, unknown>;
}

export interface CollaborationHandoff {
  nodeId: string;
  fromAgentId: string;
  toAgentId: string;
  summary: string;
  createdAt: string;
}

export interface SharedContextEntryMap {
  [key: string]: unknown;
}

export interface SharedMemoryEntry {
  key: string;
  value: unknown;
  scope: "run" | "thread" | "project";
  updatedAt: string;
}

export interface CollaborationSnapshot {
  taskGraph: {
    nodes: Record<string, CollaborationTaskNode>;
  };
  sharedContext: SharedContextEntryMap;
  sharedMemory: Record<string, SharedMemoryEntry>;
  handoffs: CollaborationHandoff[];
}

export const createCollaborationSnapshot = (
  snapshot?: Partial<CollaborationSnapshot>,
): CollaborationSnapshot => ({
  taskGraph: {
    nodes: { ...(snapshot?.taskGraph?.nodes ?? {}) },
  },
  sharedContext: { ...(snapshot?.sharedContext ?? {}) },
  sharedMemory: { ...(snapshot?.sharedMemory ?? {}) },
  handoffs: [...(snapshot?.handoffs ?? [])],
});

export class CollaborationService {
  private snapshotState: CollaborationSnapshot;

  constructor(
    snapshot?: CollaborationSnapshot,
    private readonly blackboard?: BlackboardStore,
  ) {
    this.snapshotState = createCollaborationSnapshot(snapshot);
  }

  addNode(node: CollaborationTaskNode): void {
    this.snapshotState.taskGraph.nodes[node.id] = {
      status: "pending",
      dependsOn: [],
      ...node,
      ...(node.dependsOn ? { dependsOn: [...node.dependsOn] } : {}),
    };
  }

  canStartNode(nodeId: string): boolean {
    const node = this.snapshotState.taskGraph.nodes[nodeId];
    if (!node) return false;
    return (node.dependsOn ?? []).every(
      (dependencyId) => this.snapshotState.taskGraph.nodes[dependencyId]?.status === "completed",
    );
  }

  startNode(nodeId: string): void {
    const node = this.snapshotState.taskGraph.nodes[nodeId];
    if (!node) return;
    this.snapshotState.taskGraph.nodes[nodeId] = { ...node, status: "running" };
  }

  completeNode(nodeId: string, result?: Record<string, unknown>): void {
    const node = this.snapshotState.taskGraph.nodes[nodeId];
    if (!node) return;
    this.snapshotState.taskGraph.nodes[nodeId] = {
      ...node,
      status: "completed",
      ...(result ? { result } : {}),
    };
  }

  publishSharedContext(key: string, value: unknown): void {
    this.snapshotState.sharedContext[key] = value;
  }

  publishSharedMemory(input: {
    key: string;
    value: unknown;
    scope: "run" | "thread" | "project";
  }): void {
    this.snapshotState.sharedMemory[input.key] = {
      ...input,
      updatedAt: new Date().toISOString(),
    };
  }

  recordHandoff(input: Omit<CollaborationHandoff, "createdAt">): void {
    this.snapshotState.handoffs.push({
      ...input,
      createdAt: new Date().toISOString(),
    });
  }

  async writeBlackboard(input: {
    topic: string;
    value: string;
    scope: "run" | "thread" | "project";
  }): Promise<void> {
    await this.blackboard?.write(input);
  }

  snapshot(): CollaborationSnapshot {
    return createCollaborationSnapshot(this.snapshotState);
  }
}

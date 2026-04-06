import type { AgentState } from "../types";
import type { CollaborationSnapshot } from "../collaboration/service";
import type { JobRecord } from "../jobs/scheduler";
import type { PlanSnapshot } from "../planning/service";

export interface DurableCheckpoint {
  runId: string;
  state: AgentState;
  jobs: JobRecord[];
  collaboration: CollaborationSnapshot;
  plan: PlanSnapshot;
  createdAt: string;
}

export interface CheckpointStore {
  save(checkpoint: DurableCheckpoint): Promise<void>;
  load(runId: string): Promise<DurableCheckpoint | null>;
}

export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly checkpoints = new Map<string, DurableCheckpoint>();

  async save(checkpoint: DurableCheckpoint): Promise<void> {
    this.checkpoints.set(checkpoint.runId, checkpoint);
  }

  async load(runId: string): Promise<DurableCheckpoint | null> {
    return this.checkpoints.get(runId) ?? null;
  }
}

export class DurableCheckpointService {
  constructor(private readonly store: CheckpointStore) {}

  async save(
    checkpoint: Omit<DurableCheckpoint, "createdAt"> & { createdAt?: string },
  ): Promise<void> {
    await this.store.save({
      ...checkpoint,
      createdAt: checkpoint.createdAt ?? new Date().toISOString(),
    });
  }

  async load(runId: string): Promise<DurableCheckpoint | null> {
    return await this.store.load(runId);
  }
}

import type { CheckpointRecord, CheckpointStore } from "./types";
export type { CheckpointRecord, CheckpointStore } from "./types";

export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly records = new Map<string, CheckpointRecord>();

  async load(runId: string): Promise<CheckpointRecord | null> {
    return this.records.get(runId) ?? null;
  }

  async save(record: CheckpointRecord): Promise<void> {
    this.records.set(record.runId, record);
  }

  async delete(runId: string): Promise<void> {
    this.records.delete(runId);
  }
}

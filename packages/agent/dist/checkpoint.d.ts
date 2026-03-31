import type { CheckpointRecord, CheckpointStore } from "./types";
export type { CheckpointRecord, CheckpointStore } from "./types";
export declare class InMemoryCheckpointStore implements CheckpointStore {
    private readonly records;
    load(runId: string): Promise<CheckpointRecord | null>;
    save(record: CheckpointRecord): Promise<void>;
    delete(runId: string): Promise<void>;
}
//# sourceMappingURL=checkpoint.d.ts.map
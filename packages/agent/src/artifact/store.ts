import { generateId } from "../helpers";

export type ArtifactScope = "run" | "thread" | "project";

export interface ArtifactRecord {
  id: string;
  runId: string;
  kind: string;
  title: string;
  content: string;
  scope: ArtifactScope;
  createdAt: string;
}

export interface ArtifactStore {
  save(record: Omit<ArtifactRecord, "id" | "createdAt">): Promise<ArtifactRecord>;
  list(runId: string): Promise<ArtifactRecord[]>;
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly records = new Map<string, ArtifactRecord[]>();

  async save(record: Omit<ArtifactRecord, "id" | "createdAt">): Promise<ArtifactRecord> {
    const next: ArtifactRecord = {
      id: generateId("artifact"),
      createdAt: new Date().toISOString(),
      ...record,
    };
    const current = this.records.get(record.runId) ?? [];
    current.push(next);
    this.records.set(record.runId, current);
    return next;
  }

  async list(runId: string): Promise<ArtifactRecord[]> {
    return [...(this.records.get(runId) ?? [])];
  }
}

export class ArtifactService {
  constructor(private readonly store: ArtifactStore) {}

  async save(record: Omit<ArtifactRecord, "id" | "createdAt">): Promise<ArtifactRecord> {
    return await this.store.save(record);
  }
}

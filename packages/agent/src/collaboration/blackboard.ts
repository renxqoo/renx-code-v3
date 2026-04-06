import { generateId } from "../helpers";

export type BlackboardScope = "run" | "thread" | "project";

export interface BlackboardEntry {
  id: string;
  topic: string;
  value: string;
  scope: BlackboardScope;
  createdAt: string;
  updatedAt: string;
}

export interface BlackboardStore {
  write(entry: Omit<BlackboardEntry, "id" | "createdAt" | "updatedAt">): Promise<BlackboardEntry>;
  list(topic?: string): Promise<BlackboardEntry[]>;
}

export class InMemoryBlackboardStore implements BlackboardStore {
  private readonly entries = new Map<string, BlackboardEntry>();

  async write(
    entry: Omit<BlackboardEntry, "id" | "createdAt" | "updatedAt">,
  ): Promise<BlackboardEntry> {
    const now = new Date().toISOString();
    const record: BlackboardEntry = {
      id: generateId("board"),
      createdAt: now,
      updatedAt: now,
      ...entry,
    };
    this.entries.set(record.id, record);
    return record;
  }

  async list(topic?: string): Promise<BlackboardEntry[]> {
    return [...this.entries.values()].filter((entry) => !topic || entry.topic === topic);
  }
}

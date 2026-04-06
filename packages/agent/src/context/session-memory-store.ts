import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { SessionMemoryRecord, SessionMemoryStore } from "../types";
import { createSessionMemoryRecord } from "./session-memory";

export class InMemorySessionMemoryStore implements SessionMemoryStore {
  private readonly records = new Map<string, SessionMemoryRecord>();

  async load(runId: string): Promise<SessionMemoryRecord | null> {
    return this.records.get(runId) ?? null;
  }

  async save(runId: string, record: SessionMemoryRecord): Promise<void> {
    this.records.set(runId, record);
  }
}

export class FileSessionMemoryStore implements SessionMemoryStore {
  constructor(private readonly rootDir: string) {}

  async load(runId: string): Promise<SessionMemoryRecord | null> {
    const runDir = join(this.rootDir, runId);
    const notesPath = join(runDir, "notes.md");
    const statePath = join(runDir, "state.json");

    try {
      const notes = await readFile(notesPath, "utf-8");
      let rawState = "{}";
      try {
        rawState = await readFile(statePath, "utf-8");
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
      return createSessionMemoryRecord({
        ...JSON.parse(rawState),
        notes,
      });
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }

  async save(runId: string, record: SessionMemoryRecord): Promise<void> {
    const runDir = join(this.rootDir, runId);
    const notesPath = join(runDir, "notes.md");
    const statePath = join(runDir, "state.json");
    const { notes, ...state } = record;

    await mkdir(runDir, { recursive: true });
    await Promise.all([
      writeFile(notesPath, notes, "utf-8"),
      writeFile(statePath, JSON.stringify(state, null, 2), "utf-8"),
    ]);
  }
}

const isMissingFileError = (error: unknown): boolean =>
  !!error &&
  typeof error === "object" &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT";

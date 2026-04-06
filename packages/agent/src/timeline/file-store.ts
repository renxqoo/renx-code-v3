import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { TimelineNode, TimelineStore } from "../types";

import { TimelineVersionConflictError } from "./errors";
import { TIMELINE_INTERNAL_MODE_FORK, TIMELINE_INTERNAL_MODE_KEY } from "./constants";

const isMissingFileError = (error: unknown): boolean =>
  !!error &&
  typeof error === "object" &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT";

const encodeSegment = (value: string): string => encodeURIComponent(value);

interface TimelineHeadRecord {
  nodeId: string;
}

export class FileTimelineStore implements TimelineStore {
  constructor(private readonly baseDir: string) {}

  async load(runId: string): Promise<TimelineNode | null> {
    const head = await this.readHead(runId);
    if (!head) return null;
    return await this.loadNode(runId, head.nodeId);
  }

  async loadNode(runId: string, nodeId: string): Promise<TimelineNode | null> {
    try {
      const raw = await readFile(this.getNodePath(runId, nodeId), "utf8");
      return JSON.parse(raw) as TimelineNode;
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }

  async listNodes(runId: string): Promise<TimelineNode[]> {
    try {
      const nodeDir = this.getNodeDir(runId);
      const entries = await readdir(nodeDir, { withFileTypes: true });
      const nodes = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map(async (entry) => {
            const raw = await readFile(join(nodeDir, entry.name), "utf8");
            return JSON.parse(raw) as TimelineNode;
          }),
      );
      nodes.sort((left, right) => left.version - right.version);
      return nodes;
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
  }

  async save(node: TimelineNode, expectedVersion?: number): Promise<number> {
    const currentHead = await this.load(node.runId);
    const isForkAppend =
      node.metadata?.[TIMELINE_INTERNAL_MODE_KEY] === TIMELINE_INTERNAL_MODE_FORK &&
      node.parentNodeId !== undefined &&
      node.parentNodeId !== currentHead?.nodeId;
    const parent =
      isForkAppend && node.parentNodeId !== undefined
        ? await this.loadNode(node.runId, node.parentNodeId)
        : currentHead;
    const expectedActualVersion = parent?.version;
    if (expectedVersion !== undefined && expectedActualVersion !== expectedVersion) {
      throw new TimelineVersionConflictError(
        `Expected timeline version ${expectedVersion}, got ${expectedActualVersion ?? "none"}`,
      );
    }

    const nextVersion = (currentHead?.version ?? 0) + 1;
    const now = new Date().toISOString();
    const nextNode: TimelineNode = {
      ...node,
      version: nextVersion,
      createdAt: node.createdAt || now,
      updatedAt: now,
    };

    await mkdir(this.getNodeDir(node.runId), { recursive: true });
    await Promise.all([
      writeFile(
        this.getNodePath(node.runId, node.nodeId),
        JSON.stringify(nextNode, null, 2),
        "utf8",
      ),
      writeFile(
        this.getHeadPath(node.runId),
        JSON.stringify({ nodeId: node.nodeId }, null, 2),
        "utf8",
      ),
    ]);
    return nextVersion;
  }

  async delete(runId: string): Promise<void> {
    await rm(this.getRunDir(runId), { recursive: true, force: true });
  }

  private async readHead(runId: string): Promise<TimelineHeadRecord | null> {
    try {
      const raw = await readFile(this.getHeadPath(runId), "utf8");
      return JSON.parse(raw) as TimelineHeadRecord;
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }

  private getRunDir(runId: string): string {
    return join(this.baseDir, encodeSegment(runId));
  }

  private getNodeDir(runId: string): string {
    return join(this.getRunDir(runId), "nodes");
  }

  private getNodePath(runId: string, nodeId: string): string {
    return join(this.getNodeDir(runId), `${encodeSegment(nodeId)}.json`);
  }

  private getHeadPath(runId: string): string {
    return join(this.getRunDir(runId), "head.json");
  }
}

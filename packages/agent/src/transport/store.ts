import { createHash } from "node:crypto";

export interface RemoteStorePutOptions {
  ifMatch?: string;
}

export interface RemoteStoreRecord<T> {
  value: T;
  etag: string;
  updatedAt: string;
}

const computeEtag = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class InMemoryRemoteStoreTransport<T> {
  private readonly records = new Map<string, RemoteStoreRecord<T>>();

  async get(key: string): Promise<RemoteStoreRecord<T> | null> {
    return this.records.get(key) ?? null;
  }

  async put(key: string, value: T, options?: RemoteStorePutOptions): Promise<RemoteStoreRecord<T>> {
    const existing = this.records.get(key);
    if (options?.ifMatch && existing && existing.etag !== options.ifMatch) {
      throw new Error(`ETag mismatch for key: ${key}`);
    }
    const record: RemoteStoreRecord<T> = {
      value,
      etag: computeEtag(value),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(key, record);
    return record;
  }
}

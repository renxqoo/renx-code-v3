import { generateId } from "../helpers";

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface JobRecord {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  idempotencyKey?: string;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
}

export interface JobStore {
  save(job: JobRecord): Promise<void>;
  get(id: string): Promise<JobRecord | null>;
  list(): Promise<JobRecord[]>;
}

export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>();

  async save(job: JobRecord): Promise<void> {
    this.jobs.set(job.id, { ...job });
  }

  async get(id: string): Promise<JobRecord | null> {
    const job = this.jobs.get(id);
    return job ? { ...job } : null;
  }

  async list(): Promise<JobRecord[]> {
    return [...this.jobs.values()].map((job) => ({ ...job }));
  }
}

type JobHandler = (payload: Record<string, unknown>) => Promise<unknown> | unknown;

export class JobScheduler {
  private readonly handlers = new Map<string, JobHandler>();

  constructor(private readonly store: JobStore) {}

  registerHandler(kind: string, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  async enqueue(
    kind: string,
    payload: Record<string, unknown>,
    options?: {
      idempotencyKey?: string;
      maxAttempts?: number;
      runAt?: string;
    },
  ): Promise<JobRecord> {
    if (options?.idempotencyKey) {
      const existing = (await this.store.list()).find(
        (job) =>
          job.idempotencyKey === options.idempotencyKey &&
          job.status !== "failed" &&
          job.status !== "cancelled",
      );
      if (existing) return existing;
    }
    const now = new Date().toISOString();
    const job: JobRecord = {
      id: generateId("job"),
      kind,
      payload: { ...payload },
      status: "pending",
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? 1,
      nextRunAt: options?.runAt ?? now,
      createdAt: now,
      updatedAt: now,
      ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    };
    await this.store.save(job);
    return job;
  }

  async get(jobId: string): Promise<JobRecord | null> {
    return await this.store.get(jobId);
  }

  async runDueJobs(now = new Date().toISOString()): Promise<void> {
    let pending = true;
    while (pending) {
      pending = false;
      const currentNow = new Date().toISOString();
      const jobs = await this.store.list();
      for (const job of jobs) {
        if (job.status !== "pending") continue;
        if (job.nextRunAt > currentNow && job.nextRunAt > now) continue;
        pending = true;
        await this.runJob(job);
      }
    }
  }

  async snapshot(): Promise<JobRecord[]> {
    return await this.store.list();
  }

  private async runJob(job: JobRecord): Promise<void> {
    const handler = this.handlers.get(job.kind);
    if (!handler) {
      await this.store.save({
        ...job,
        status: "failed",
        attempts: job.attempts + 1,
        updatedAt: new Date().toISOString(),
        error: `No handler registered for job kind: ${job.kind}`,
      });
      return;
    }

    const started: JobRecord = {
      ...job,
      status: "running",
      attempts: job.attempts + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.store.save(started);

    try {
      const result = await handler(job.payload);
      await this.store.save({
        ...started,
        status: "completed",
        updatedAt: new Date().toISOString(),
        result,
      });
    } catch (error) {
      const retryable =
        error &&
        typeof error === "object" &&
        "retryable" in error &&
        (error as { retryable?: boolean }).retryable === true;
      const canRetry = retryable && started.attempts < started.maxAttempts;
      await this.store.save({
        ...started,
        status: canRetry ? "pending" : "failed",
        updatedAt: new Date().toISOString(),
        nextRunAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Job execution failed",
      });
    }
  }
}

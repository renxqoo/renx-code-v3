import { describe, expect, it } from "vitest";

import {
  DurableCheckpointService,
  InMemoryCheckpointStore,
  InMemoryJobStore,
  JobScheduler,
  createCollaborationSnapshot,
  createPlanSnapshot,
} from "../src";
import { baseCtx } from "./helpers";

describe("jobs and checkpoints", () => {
  it("deduplicates jobs by idempotency key, retries failures, and persists durable checkpoints", async () => {
    const jobStore = new InMemoryJobStore();
    const scheduler = new JobScheduler(jobStore);
    let attempts = 0;

    scheduler.registerHandler("memory-auto-save", async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("transient failure"), { retryable: true });
      }
      return { saved: true };
    });

    const first = await scheduler.enqueue(
      "memory-auto-save",
      { runId: "run_1" },
      {
        idempotencyKey: "run_1:auto-save",
        maxAttempts: 2,
      },
    );
    const second = await scheduler.enqueue(
      "memory-auto-save",
      { runId: "run_1" },
      {
        idempotencyKey: "run_1:auto-save",
        maxAttempts: 2,
      },
    );

    expect(second.id).toBe(first.id);

    await scheduler.runDueJobs();
    const afterRetry = await scheduler.get(first.id);
    expect(afterRetry?.status).toBe("completed");
    expect(afterRetry?.attempts).toBe(2);

    const checkpointStore = new InMemoryCheckpointStore();
    const checkpointService = new DurableCheckpointService(checkpointStore);
    const ctx = baseCtx({ inputText: "continue" });
    ctx.state.runId = "run_1";

    await checkpointService.save({
      runId: "run_1",
      state: ctx.state,
      jobs: await scheduler.snapshot(),
      collaboration: createCollaborationSnapshot({
        sharedContext: { activeWorkspace: "packages/agent" },
      }),
      plan: createPlanSnapshot({
        goal: "Ship the fix",
        steps: [{ id: "step-1", title: "Write red tests", status: "completed" }],
      }),
    });

    const restored = await checkpointService.load("run_1");
    expect(restored?.jobs[0]?.status).toBe("completed");
    expect(restored?.collaboration.sharedContext["activeWorkspace"]).toBe("packages/agent");
    expect(restored?.plan.goal).toBe("Ship the fix");
  });
});

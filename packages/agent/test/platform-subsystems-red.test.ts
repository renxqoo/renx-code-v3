import { describe, expect, it } from "vitest";

import {
  ArtifactService,
  ContextSourceTaxonomy,
  InMemoryArtifactStore,
  InMemoryRemoteStoreTransport,
  PolicyPackRegistry,
  PlanService,
  ReplayHarness,
  RunbookService,
  createPlanSnapshot,
} from "../src";
import { baseCtx } from "./helpers";

describe("platform subsystems", () => {
  it("supports transport, artifacts, planning, taxonomy, runbooks, replay, and policy packs", async () => {
    const transport = new InMemoryRemoteStoreTransport<{ version: number }>();
    const firstWrite = await transport.put("timeline/run_1", { version: 1 });
    const secondWrite = await transport.put(
      "timeline/run_1",
      { version: 2 },
      {
        ifMatch: firstWrite.etag,
      },
    );
    expect(secondWrite.etag).not.toBe(firstWrite.etag);

    const artifacts = new ArtifactService(new InMemoryArtifactStore());
    const artifact = await artifacts.save({
      runId: "run_1",
      kind: "test_report",
      title: "Vitest report",
      content: "470 passed",
      scope: "run",
    });

    const planner = new PlanService();
    const plan = planner.updateStep(
      createPlanSnapshot({
        goal: "Ship enterprise SDK",
        steps: [{ id: "step-1", title: "Red tests", status: "pending" }],
      }),
      "step-1",
      { status: "completed" },
    );

    const taxonomy = new ContextSourceTaxonomy();
    const classified = taxonomy.classify({
      id: "memory:recent-files",
      kind: "memory",
      source: "rehydration",
    });

    const runbook = new RunbookService([
      {
        id: "prompt-too-long",
        match: { errorCodes: ["MODEL_PROMPT_TOO_LONG"] },
        actions: ["compact_context", "retry"],
      },
    ]);
    const resolution = runbook.resolve({
      code: "MODEL_PROMPT_TOO_LONG",
      message: "too long",
    });

    const replay = new ReplayHarness();
    const snapshot = replay.capture(baseCtx({ inputText: "continue" }), {
      capturedAt: "2026-04-05T00:00:00.000Z",
      systemPrompt: "You are helpful.",
      messages: [],
      toolNames: [],
    });

    const packs = new PolicyPackRegistry();
    packs.register({
      name: "enterprise-default",
      memory: { maxContentChars: 1024 },
      prompt: { reservedTokens: 400 },
    });
    const merged = packs.resolve(["enterprise-default"]);

    expect(artifact.id).toMatch(/^artifact_/);
    expect(plan.steps[0]?.status).toBe("completed");
    expect(classified.retentionClass).toBe("compact_safe");
    expect(resolution.actions).toEqual(["compact_context", "retry"]);
    expect(snapshot.runId).toBe("run_1");
    expect(merged.memory?.maxContentChars).toBe(1024);
  });
});

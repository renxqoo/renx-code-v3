import { describe, expect, it } from "vitest";

import { CollaborationService, InMemoryBlackboardStore, createCollaborationSnapshot } from "../src";

describe("collaboration subsystem", () => {
  it("manages task graphs, handoffs, shared memory, and blackboard entries", async () => {
    const blackboard = new InMemoryBlackboardStore();
    const service = new CollaborationService(createCollaborationSnapshot(), blackboard);

    service.addNode({
      id: "task:analyze",
      title: "Analyze repo",
      objective: "Read the repo and capture constraints.",
    });
    service.addNode({
      id: "task:fix",
      title: "Fix bug",
      objective: "Implement the patch.",
      dependsOn: ["task:analyze"],
    });

    expect(service.canStartNode("task:fix")).toBe(false);

    service.startNode("task:analyze");
    service.completeNode("task:analyze", { summary: "Repo uses pnpm and Vitest." });

    expect(service.canStartNode("task:fix")).toBe(true);

    service.publishSharedMemory({
      key: "repo:package-manager",
      value: "pnpm",
      scope: "project",
    });
    service.publishSharedContext("activeWorkspace", "packages/agent");
    await service.writeBlackboard({
      topic: "risks",
      value: "Context compaction can erase recent file chains if not rehydrated.",
      scope: "run",
    });
    service.recordHandoff({
      nodeId: "task:analyze",
      fromAgentId: "planner",
      toAgentId: "implementer",
      summary: "Analysis completed, proceed with fix.",
    });

    const snapshot = service.snapshot();
    expect(snapshot.taskGraph.nodes["task:fix"]?.dependsOn).toEqual(["task:analyze"]);
    expect(snapshot.sharedMemory["repo:package-manager"]?.value).toBe("pnpm");
    expect(snapshot.sharedContext["activeWorkspace"]).toBe("packages/agent");
    expect(snapshot.handoffs[0]?.toAgentId).toBe("implementer");
    expect((await blackboard.list("risks")).length).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AgentError } from "../../src/errors";
import { MiddlewarePipeline } from "../../src/middleware/pipeline";
import type { AgentMiddleware } from "../../src/middleware/types";
import { baseCtx } from "../helpers";

describe("MiddlewarePipeline", () => {
  it("runs beforeRun hooks in order", async () => {
    const order: string[] = [];
    const mw1: AgentMiddleware = {
      name: "mw1",
      beforeRun: () => {
        order.push("mw1");
      },
    };
    const mw2: AgentMiddleware = {
      name: "mw2",
      beforeRun: () => {
        order.push("mw2");
      },
    };

    const pipeline = new MiddlewarePipeline([mw1, mw2]);
    await pipeline.runBeforeRun(baseCtx());
    expect(order).toEqual(["mw1", "mw2"]);
  });

  it("chains beforeModel modifications", async () => {
    const mw1: AgentMiddleware = {
      name: "mw1",
      beforeModel: (_ctx, req) => ({ ...req, systemPrompt: req.systemPrompt + " [mw1]" }),
    };
    const mw2: AgentMiddleware = {
      name: "mw2",
      beforeModel: (_ctx, req) => ({ ...req, systemPrompt: req.systemPrompt + " [mw2]" }),
    };

    const pipeline = new MiddlewarePipeline([mw1, mw2]);
    const result = await pipeline.runBeforeModel(baseCtx(), {
      model: "test",
      systemPrompt: "base",
      messages: [],
      tools: [],
    });

    expect(result.systemPrompt).toBe("base [mw1] [mw2]");
  });

  it("aggregates beforeTool decisions", async () => {
    const mw1: AgentMiddleware = {
      name: "mw1",
      beforeTool: () => ({ statePatch: { mergeMemory: { a: 1 } } }),
    };
    const mw2: AgentMiddleware = {
      name: "mw2",
      beforeTool: () => ({ statePatch: { mergeMemory: { b: 2 } }, stopCurrentStep: true }),
    };

    const pipeline = new MiddlewarePipeline([mw1, mw2]);
    const decision = await pipeline.runBeforeTool(baseCtx(), {
      id: "tc_1",
      name: "test",
      input: {},
    });

    expect(decision.shouldStop).toBe(true);
    expect(decision.statePatch).toHaveLength(2);
  });

  it("handles onError without throwing", async () => {
    const order: string[] = [];
    const mw1: AgentMiddleware = {
      name: "mw1",
      onError: () => {
        order.push("mw1");
      },
    };
    const mw2: AgentMiddleware = {
      name: "mw2",
      onError: () => {
        throw new Error("mw2 broke");
      },
    };
    const mw3: AgentMiddleware = {
      name: "mw3",
      onError: () => {
        order.push("mw3");
      },
    };

    const pipeline = new MiddlewarePipeline([mw1, mw2, mw3]);
    await pipeline.runOnError(baseCtx(), new AgentError({ code: "SYSTEM_ERROR", message: "test" }));
    expect(order).toEqual(["mw1", "mw3"]); // mw2 error swallowed
  });

  it("runs afterRun hooks", async () => {
    const order: string[] = [];
    const mw: AgentMiddleware = {
      name: "cleanup",
      afterRun: () => {
        order.push("cleanup");
      },
    };

    const pipeline = new MiddlewarePipeline([mw]);
    const mockResult = { runId: "r1", status: "completed" as const, state: baseCtx().state };
    await pipeline.runAfterRun(baseCtx(), mockResult);
    expect(order).toEqual(["cleanup"]);
  });

  it("handles empty pipeline gracefully", async () => {
    const pipeline = new MiddlewarePipeline([]);
    const decision = await pipeline.runBeforeTool(baseCtx(), {
      id: "tc_1",
      name: "test",
      input: {},
    });
    expect(decision.shouldStop).toBe(false);
    expect(decision.statePatch).toHaveLength(0);
  });

  it("runAfterModel chains model response modifications", async () => {
    const mw1: AgentMiddleware = {
      name: "mw1",
      afterModel: (_ctx, resp) => ({
        ...resp,
        output: (resp as { output?: string }).output + " [mw1]",
      }),
    };
    const mw2: AgentMiddleware = {
      name: "mw2",
      afterModel: (_ctx, resp) => ({
        ...resp,
        output: (resp as { output?: string }).output + " [mw2]",
      }),
    };

    const pipeline = new MiddlewarePipeline([mw1, mw2]);
    const result = await pipeline.runAfterModel(baseCtx(), {
      type: "final",
      output: "base",
    });

    expect((result as { output: string }).output).toBe("base [mw1] [mw2]");
  });

  it("runAfterAssistantFinal aggregates continue message and state patches", async () => {
    const mw1: AgentMiddleware = {
      name: "mw1",
      afterAssistantFinal: () => ({
        statePatch: { mergeMemory: { gate1: true } },
        continueWithUserMessage: "first follow-up",
      }),
    };
    const mw2: AgentMiddleware = {
      name: "mw2",
      afterAssistantFinal: () => ({
        statePatch: { mergeMemory: { gate2: true } },
        continueWithUserMessage: "second follow-up",
      }),
    };

    const pipeline = new MiddlewarePipeline([mw1, mw2]);
    const decision = await pipeline.runAfterAssistantFinal(baseCtx(), {
      type: "final",
      output: "done",
    });

    expect(decision.statePatch).toHaveLength(2);
    expect(decision.continueWithUserMessage).toBe("second follow-up");
  });

  it("runAfterTool aggregates decisions from middleware", async () => {
    const mw1: AgentMiddleware = {
      name: "mw1",
      afterTool: () => ({ statePatch: { mergeMemory: { x: 1 } } }),
    };
    const mw2: AgentMiddleware = {
      name: "mw2",
      afterTool: () => ({ statePatch: { mergeMemory: { y: 2 } }, stopCurrentStep: true }),
    };

    const pipeline = new MiddlewarePipeline([mw1, mw2]);
    const decision = await pipeline.runAfterTool(baseCtx(), {
      tool: {
        name: "test",
        description: "desc",
        schema: z.object({}).passthrough(),
        invoke: async () => ({ content: "" }),
      },
      call: { id: "tc_1", name: "test", input: {} },
      output: { content: "done" },
    });

    expect(decision.shouldStop).toBe(true);
    expect(decision.statePatch).toHaveLength(2);
  });

  it("afterRun receives result parameter", async () => {
    let receivedResult: { runId: string; status: string } | undefined;
    const mw: AgentMiddleware = {
      name: "result-check",
      afterRun: (_ctx, result) => {
        receivedResult = { runId: result.runId, status: result.status };
      },
    };

    const pipeline = new MiddlewarePipeline([mw]);
    const mockResult = { runId: "r_abc", status: "completed" as const, state: baseCtx().state };
    await pipeline.runAfterRun(baseCtx(), mockResult);

    expect(receivedResult).toBeDefined();
    expect(receivedResult!.runId).toBe("r_abc");
    expect(receivedResult!.status).toBe("completed");
  });

  it("onError receives AgentError", async () => {
    let receivedError: AgentError | undefined;
    const mw: AgentMiddleware = {
      name: "error-capture",
      onError: (_ctx, error) => {
        receivedError = error;
      },
    };

    const pipeline = new MiddlewarePipeline([mw]);
    const error = new AgentError({ code: "TOOL_ERROR", message: "something broke" });
    await pipeline.runOnError(baseCtx(), error);

    expect(receivedError).toBe(error);
    expect(receivedError!.code).toBe("TOOL_ERROR");
    expect(receivedError!.message).toBe("something broke");
  });
});

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AgentError } from "../../src/errors";
import { AgentMemoryMiddleware } from "../../src/middleware/agent-memory";
import type { Store } from "../../src/types";
import { baseCtx } from "../helpers";

function makeStore(overrides?: {
  loadReturn?: Record<string, unknown>;
  saveFn?: (ctx: unknown, data: unknown) => Promise<void> | void;
}): Store {
  return {
    load: () => overrides?.loadReturn ?? {},
    ...(overrides?.saveFn ? { save: overrides.saveFn } : {}),
  };
}

function makeToolResult() {
  return {
    tool: {
      name: "test",
      description: "desc",
      schema: z.object({}).passthrough(),
      invoke: async () => ({ content: "" }),
    },
    call: { id: "tc_1", name: "test", input: {} },
    output: { content: "done" },
  };
}

describe("AgentMemoryMiddleware", () => {
  // 1. beforeModel loads memory on first call
  it("loads memory via store.load on first beforeModel call", async () => {
    const load = vi.fn(() => ({ user_name: "Alice", preferences: { lang: "en" } }));
    const store: Store = { load };
    const mw = new AgentMemoryMiddleware(store);
    const ctx = baseCtx();

    await mw.beforeModel!(ctx, {
      model: "m",
      systemPrompt: "original",
      messages: [],
      tools: [],
    });

    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith(ctx);
    expect(ctx.state.memory).toEqual({ user_name: "Alice", preferences: { lang: "en" } });
  });

  // 2. beforeModel injects systemPrompt when memory is non-empty
  it("injects <user_memory> block into systemPrompt when memory is non-empty", async () => {
    const store = makeStore({ loadReturn: { key: "value" } });
    const mw = new AgentMemoryMiddleware(store);
    const ctx = baseCtx();

    const req = await mw.beforeModel!(ctx, {
      model: "m",
      systemPrompt: "You are helpful.",
      messages: [],
      tools: [],
    });

    expect(req.systemPrompt).toBe(
      'You are helpful.\n<user_memory>\n{"key":"value"}\n</user_memory>',
    );
  });

  // 3. beforeModel does not repeat load on second call
  it("does not call store.load on subsequent beforeModel calls", async () => {
    const load = vi.fn(() => ({ a: 1 }));
    const store: Store = { load };
    const mw = new AgentMemoryMiddleware(store);
    const ctx = baseCtx();

    await mw.beforeModel!(ctx, { model: "m", systemPrompt: "p", messages: [], tools: [] });
    await mw.beforeModel!(ctx, { model: "m", systemPrompt: "p", messages: [], tools: [] });

    expect(load).toHaveBeenCalledOnce();
  });

  // 4. beforeModel does not inject when memory is empty
  it("does not inject systemPrompt when memory is empty", async () => {
    const store = makeStore({ loadReturn: {} });
    const mw = new AgentMemoryMiddleware(store);
    const ctx = baseCtx();

    const req = await mw.beforeModel!(ctx, {
      model: "m",
      systemPrompt: "original",
      messages: [],
      tools: [],
    });

    expect(req.systemPrompt).toBe("original");
  });

  // 5. afterTool saves memory
  it("saves memory after tool execution via afterTool", async () => {
    const save = vi.fn();
    const store = makeStore({ saveFn: save });
    const mw = new AgentMemoryMiddleware(store);
    const ctx = { ...baseCtx(), state: { ...baseCtx().state, memory: { key: "value" } } };

    // Trigger load so loaded flag is set
    await mw.beforeModel!(ctx, { model: "m", systemPrompt: "p", messages: [], tools: [] });

    await mw.afterTool!(ctx, makeToolResult());

    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(ctx, { key: "value" });
  });

  // 6. onError saves memory
  it("saves memory on error via onError", async () => {
    const save = vi.fn();
    const store = makeStore({ saveFn: save });
    const mw = new AgentMemoryMiddleware(store);
    const ctx = { ...baseCtx(), state: { ...baseCtx().state, memory: { err: "data" } } };
    const error = new AgentError({ code: "SYSTEM_ERROR", message: "boom" });

    await mw.onError!(ctx, error);

    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(ctx, { err: "data" });
  });

  // 7. afterRun saves memory
  it("saves memory at end of run via afterRun", async () => {
    const save = vi.fn();
    const store = makeStore({ saveFn: save });
    const mw = new AgentMemoryMiddleware(store);
    const ctx = { ...baseCtx(), state: { ...baseCtx().state, memory: { final: true } } };
    const result = { runId: "r1", status: "completed" as const, state: ctx.state };

    await mw.afterRun!(ctx, result);

    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(ctx, { final: true });
  });

  // 8. store.save undefined — no error
  it("does not throw when store.save is undefined", async () => {
    const store = makeStore(); // no save
    const mw = new AgentMemoryMiddleware(store);
    const ctx = baseCtx();

    // Trigger load
    await mw.beforeModel!(ctx, { model: "m", systemPrompt: "p", messages: [], tools: [] });

    // afterTool
    await expect(mw.afterTool!(ctx, makeToolResult())).resolves.toBeUndefined();
    // onError
    const error = new AgentError({ code: "SYSTEM_ERROR", message: "x" });
    await expect(mw.onError!(ctx, error)).resolves.toBeUndefined();
    // afterRun
    const result = { runId: "r1", status: "completed" as const, state: ctx.state };
    await expect(mw.afterRun!(ctx, result)).resolves.toBeUndefined();
  });

  // 9. middleware name
  it("has the correct middleware name", () => {
    const mw = new AgentMemoryMiddleware(makeStore());
    expect(mw.name).toBe("agent-memory");
  });

  // 10. injectAs: "user" appends a user message instead of modifying systemPrompt
  it("injects memory as a user message when injectAs is 'user'", async () => {
    const store = makeStore({ loadReturn: { key: "value" } });
    const mw = new AgentMemoryMiddleware(store, { injectAs: "user" });
    const ctx = baseCtx();

    const req = await mw.beforeModel!(ctx, {
      model: "m",
      systemPrompt: "You are helpful.",
      messages: [],
      tools: [],
    });

    expect(req.systemPrompt).toBe("You are helpful.");
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]!.role).toBe("user");
    expect(req.messages[0]!.content).toBe('<user_memory>\n{"key":"value"}\n</user_memory>');
  });
});

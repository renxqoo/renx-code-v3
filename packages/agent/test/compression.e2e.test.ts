import { describe, expect, it } from "vitest";

import type { ModelClient, ModelRequest, ModelResponse } from "@renx/model";

import { AgentRuntime } from "../src/runtime";
import type { RunMessage } from "../src/message/types";
import { baseCtx } from "./helpers";

const buildInputMessages = (count: number): RunMessage[] =>
  Array.from({ length: count }, (_, idx) => ({
    id: `cmp_${idx}`,
    messageId: `cmp_msg_${idx}`,
    role: idx % 2 === 0 ? "user" : "assistant",
    content: `compression-content-${idx}-${"x".repeat(120)}`,
    createdAt: new Date(1_700_100_000_000 + idx).toISOString(),
    source: "input",
    roundIndex: Math.floor(idx / 2),
  }));

const buildCompressionRuntime = (
  modelClient: ModelClient,
  contextOverrides?: Partial<{
    maxInputTokens: number;
    maxOutputTokens: number;
    maxPromptTooLongRetries: number;
    maxReactiveCompactAttempts: number;
    maxCompactRequestRetries: number;
    compactRequestMaxInputChars: number;
    maxConsecutiveCompactFailures: number;
    toolResultSoftCharLimit: number;
    historySnipKeepRounds: number;
    historySnipMaxDropRounds: number;
    microcompactMaxToolChars: number;
    collapseRestoreMaxMessages: number;
    collapseRestoreTokenHeadroomRatio: number;
    rehydrationTokenBudget: number;
    recentFileBudgetTokens: number;
    skillsRehydrateBudgetTokens: number;
  }>,
) =>
  new AgentRuntime({
    name: "compression-e2e",
    modelClient,
    model: "test-model",
    tools: [],
    systemPrompt: "You are helpful.",
    maxSteps: 6,
    context: {
      maxInputTokens: 1_500,
      maxOutputTokens: 200,
      maxPromptTooLongRetries: 3,
      maxReactiveCompactAttempts: 3,
      maxCompactRequestRetries: 2,
      compactRequestMaxInputChars: 20_000,
      maxConsecutiveCompactFailures: 3,
      toolResultSoftCharLimit: 6_000,
      historySnipKeepRounds: 2,
      historySnipMaxDropRounds: 1,
      microcompactMaxToolChars: 500,
      collapseRestoreMaxMessages: 8,
      collapseRestoreTokenHeadroomRatio: 0.6,
      rehydrationTokenBudget: 50_000,
      recentFileBudgetTokens: 5_000,
      skillsRehydrateBudgetTokens: 25_000,
      ...(contextOverrides ?? {}),
      thresholds: {
        warningBufferTokens: 0,
        autoCompactBufferTokens: 0,
        errorBufferTokens: 0,
        blockingHeadroomTokens: -10_000,
      },
    },
  });

describe("Compression E2E", () => {
  it.each([
    {
      name: "prompt_too_long",
      rawType: "prompt_too_long",
      message: "prompt too long",
      expected: "Recovered from prompt-too-long",
      count: 14,
    },
    {
      name: "max_output_tokens",
      rawType: "max_output_tokens",
      message: "max output tokens exceeded",
      expected: "Recovered from max-output",
      count: 18,
    },
    {
      name: "context_length_exceeded",
      rawType: "context_length_exceeded",
      message: "context window exceeded",
      expected: "Recovered from context-overflow",
      count: 22,
    },
    {
      name: "media_too_large",
      rawType: "media_too_large",
      message: "media too large",
      expected: "Recovered from media-limit",
      count: 26,
    },
  ])("reactive compact recovers for $name with $count messages", async (c) => {
    let called = 0;
    const modelClient: ModelClient = {
      generate: async () => {
        called += 1;
        if (called === 1) {
          throw {
            code: "INVALID_REQUEST",
            rawType: c.rawType,
            message: c.message,
          };
        }
        return { type: "final", output: c.expected };
      },
      stream: async function* () {
        yield { type: "done" as const };
      },
      resolve: () => ({ logicalModel: "test", provider: "test", providerModel: "test" }),
    };

    const runtime = buildCompressionRuntime(modelClient);
    const ctx = baseCtx();
    ctx.input.messages = buildInputMessages(c.count);
    const result = await runtime.run(ctx);

    expect(result.status).toBe("completed");
    expect(result.output).toBe(c.expected);
    expect(called).toBeGreaterThanOrEqual(2);
  });

  it("reactive compact also recovers on stream path", async () => {
    let streamAttempts = 0;
    const modelClient: ModelClient = {
      generate: async () => ({ type: "final", output: "unused" }),
      stream: async function* () {
        streamAttempts += 1;
        if (streamAttempts === 1) {
          throw {
            code: "INVALID_REQUEST",
            rawType: "prompt_too_long",
            message: "prompt too long",
          };
        }
        yield { type: "text_delta" as const, text: "Recovered on stream path" };
        yield { type: "done" as const };
      },
      resolve: () => ({ logicalModel: "test", provider: "test", providerModel: "test" }),
    };

    const runtime = buildCompressionRuntime(modelClient);
    const ctx = baseCtx();
    ctx.input.messages = buildInputMessages(28);
    const iter = runtime.stream(ctx);
    let finalResult: { status: string; output?: string } | undefined;
    while (true) {
      const next = await iter.next();
      if (next.done) {
        finalResult = next.value;
        break;
      }
    }
    expect(finalResult).toBeDefined();
    expect(finalResult!.status).toBe("completed");
    expect(finalResult!.output).toBe("Recovered on stream path");
    expect(streamAttempts).toBe(2);
  });

  it("compact summary refine updates forked cache prefix", async () => {
    let compactRefineCalled = false;
    const modelClient: ModelClient = {
      generate: async (request: ModelRequest) => {
        if (request.metadata?.["compactRefine"]) {
          compactRefineCalled = true;
          return { type: "final", output: "refined summary", responseId: "resp_cache_prefix" };
        }
        return { type: "final", output: "ok" };
      },
      stream: async function* () {
        yield { type: "done" as const };
      },
      resolve: () => ({ logicalModel: "test", provider: "test", providerModel: "test" }),
    };

    const runtime = buildCompressionRuntime(modelClient, {
      maxInputTokens: 1_000,
    });
    const ctx = baseCtx();
    ctx.state.messages = [
      {
        id: "summary_seed",
        messageId: "summary_seed_msg",
        role: "system",
        content: "[Compact Summary:s1]\nseed summary",
        createdAt: new Date().toISOString(),
        source: "framework",
      },
    ];

    const result = await runtime.run(ctx);
    expect(result.status).toBe("completed");
    expect(compactRefineCalled).toBe(true);
    expect(result.state.context?.forkedCachePrefix).toBe("resp_cache_prefix");
  });

  it("compact summary refine failure degrades and run still completes", async () => {
    const modelClient: ModelClient = {
      generate: async (request: ModelRequest): Promise<ModelResponse> => {
        if (request.metadata?.["compactRefine"]) {
          throw new Error("refine failed");
        }
        return { type: "final", output: "main response ok" };
      },
      stream: async function* () {
        yield { type: "done" as const };
      },
      resolve: () => ({ logicalModel: "test", provider: "test", providerModel: "test" }),
    };

    const runtime = buildCompressionRuntime(modelClient, {
      maxInputTokens: 1_000,
    });
    const ctx = baseCtx();
    ctx.state.messages = [
      {
        id: "summary_seed",
        messageId: "summary_seed_msg",
        role: "system",
        content: "[Compact Summary:s1]\nseed summary",
        createdAt: new Date().toISOString(),
        source: "framework",
      },
    ];

    const result = await runtime.run(ctx);
    expect(result.status).toBe("completed");
    expect(result.output).toBe("main response ok");
  });

  it("breaker-open path blocks model call and fails with CONTEXT_OVERFLOW", async () => {
    let called = 0;
    const modelClient: ModelClient = {
      generate: async () => {
        called += 1;
        return { type: "final", output: "should not happen" };
      },
      stream: async function* () {
        yield { type: "done" as const };
      },
      resolve: () => ({ logicalModel: "test", provider: "test", providerModel: "test" }),
    };

    const runtime = buildCompressionRuntime(modelClient);
    const ctx = baseCtx();
    ctx.state.context = {
      ...(ctx.state.context ?? {
        roundIndex: 0,
        lastLayerExecutions: [],
        consecutiveCompactFailures: 0,
        promptTooLongRetries: 0,
        toolResultCache: {},
        preservedSegments: {},
        compactBoundaries: [],
      }),
      consecutiveCompactFailures: 99,
    };
    ctx.input.messages = buildInputMessages(20);

    const result = await runtime.run(ctx);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("CONTEXT_OVERFLOW");
    expect(called).toBe(0);
  });

  it("breaker-open path also blocks stream before model call", async () => {
    let called = 0;
    const modelClient: ModelClient = {
      generate: async () => {
        called += 1;
        return { type: "final", output: "should not happen" };
      },
      stream: async function* () {
        yield { type: "done" as const };
      },
      resolve: () => ({ logicalModel: "test", provider: "test", providerModel: "test" }),
    };

    const runtime = buildCompressionRuntime(modelClient);
    const ctx = baseCtx();
    ctx.state.context = {
      ...(ctx.state.context ?? {
        roundIndex: 0,
        lastLayerExecutions: [],
        consecutiveCompactFailures: 0,
        promptTooLongRetries: 0,
        toolResultCache: {},
        preservedSegments: {},
        compactBoundaries: [],
      }),
      consecutiveCompactFailures: 99,
    };
    ctx.input.messages = buildInputMessages(40);

    const iter = runtime.stream(ctx);
    let finalResult: { status: string; error?: { code?: string } } | undefined;
    while (true) {
      const next = await iter.next();
      if (next.done) {
        finalResult = next.value;
        break;
      }
    }
    expect(finalResult).toBeDefined();
    expect(finalResult!.status).toBe("failed");
    expect(finalResult!.error?.code).toBe("CONTEXT_OVERFLOW");
    expect(called).toBe(0);
  });
});

import { describe, expect, it } from "vitest";

import type { AgentMessage, ToolDefinition } from "@renx/model";

import { ContextOrchestrator, initialContextRuntimeState } from "../../src/context";
import { estimateInputTokens } from "../../src/context/budget";
import { buildBudgetSnapshot } from "../../src/context/thresholds";
import type { ContextManagerConfig } from "../../src/context/types";
import type { RunMessage } from "../../src/message/types";

const noTools: ToolDefinition[] = [];

const makeRunMessage = (idx: number, roundIndex: number, content: string): RunMessage => ({
  id: `m_${idx}`,
  messageId: `msg_${idx}`,
  role: idx % 2 === 0 ? "user" : "assistant",
  content,
  createdAt: new Date(1_700_000_000_000 + idx).toISOString(),
  roundIndex,
  source: "input",
});

const toApiMessage = (message: RunMessage): AgentMessage => {
  const { messageId: _messageId, source: _source, ...apiMessage } = message;
  return apiMessage;
};

describe("ContextOrchestrator red tests from design docs", () => {
  it("默认 PTL 重试上限应为 3 次（第 4 次失败）", () => {
    const orchestrator = new ContextOrchestrator();
    const canonical = Array.from({ length: 30 }, (_, idx) =>
      makeRunMessage(idx, Math.floor(idx / 2), `payload-${idx}-${"x".repeat(300)}`),
    );

    let state = initialContextRuntimeState();
    for (let i = 0; i < 3; i += 1) {
      const recovered = orchestrator.onReactiveRecovery({
        contextState: state,
        canonicalMessages: canonical,
        reason: "prompt_too_long",
        memory: {},
      });
      expect(recovered.recovered).toBe(true);
      state = recovered.nextState;
    }

    const exhausted = orchestrator.onReactiveRecovery({
      contextState: state,
      canonicalMessages: canonical,
      reason: "prompt_too_long",
      memory: {},
    });
    expect(exhausted.recovered).toBe(false);
  });

  it("history snip 默认应至少保留最近 50 个 round", () => {
    const orchestrator = new ContextOrchestrator({
      maxInputTokens: 1_000,
      thresholds: {
        warningBufferTokens: 0,
        autoCompactBufferTokens: 999,
        errorBufferTokens: -1_000_000,
        blockingHeadroomTokens: 0,
      },
    });

    const canonical = Array.from({ length: 60 }, (_, idx) =>
      makeRunMessage(idx, idx, `round-${idx}-${"y".repeat(80)}`),
    );

    const prepared = orchestrator.prepare({
      systemPrompt: "system",
      tools: noTools,
      apiView: canonical.map(toApiMessage),
      canonicalMessages: canonical,
      memory: {},
      contextState: initialContextRuntimeState(),
    });

    expect((prepared.canonicalMessages ?? canonical).length).toBeGreaterThanOrEqual(50);
  });

  it("JSON 内容估算应使用更高密度系数（相同长度下 tokens 更高）", () => {
    const state = initialContextRuntimeState();
    const jsonLike = `{"data":"${"x".repeat(980)}"}`;
    const plainText = "p".repeat(jsonLike.length);

    const textEstimate = estimateInputTokens({
      systemPrompt: "",
      messages: [
        {
          id: "plain",
          role: "user",
          content: plainText,
          createdAt: new Date().toISOString(),
        },
      ],
      tools: [],
      state,
    });

    const jsonEstimate = estimateInputTokens({
      systemPrompt: "",
      messages: [
        {
          id: "json",
          role: "user",
          content: jsonLike,
          createdAt: new Date().toISOString(),
        },
      ],
      tools: [],
      state,
    });

    expect(jsonEstimate).toBeGreaterThan(textEstimate);
  });

  it("blocking 阈值应按 3000 headroom 计算，而不是固定比例", () => {
    const config: ContextManagerConfig = {
      maxInputTokens: 100_000,
      maxOutputTokens: 8_000,
      maxPromptTooLongRetries: 3,
      maxReactiveCompactAttempts: 3,
      maxCompactRequestRetries: 2,
      compactRequestMaxInputChars: 20_000,
      maxConsecutiveCompactFailures: 3,
      toolResultSoftCharLimit: 6_000,
      historySnipKeepRounds: 50,
      historySnipMaxDropRounds: 10,
      microcompactMaxToolChars: 1_500,
      collapseRestoreMaxMessages: 8,
      collapseRestoreTokenHeadroomRatio: 0.6,
      rehydrationTokenBudget: 50_000,
      recentFileBudgetTokens: 5_000,
      skillsRehydrateBudgetTokens: 25_000,
      thresholds: {
        warningRatio: 0.7,
        autoCompactRatio: 0.82,
        errorRatio: 0.92,
        blockingRatio: 0.98,
      },
    };

    const snapshot = buildBudgetSnapshot(40_000, config);
    expect(snapshot.blockingThreshold).toBe(97_000);
  });

  it("reactive compact attempts should respect maxReactiveCompactAttempts", () => {
    const orchestrator = new ContextOrchestrator({
      maxReactiveCompactAttempts: 1,
    });
    const canonical = Array.from({ length: 20 }, (_, idx) =>
      makeRunMessage(idx, Math.floor(idx / 2), `payload-${idx}-${"z".repeat(120)}`),
    );

    const first = orchestrator.onReactiveRecovery({
      contextState: initialContextRuntimeState(),
      canonicalMessages: canonical,
      reason: "prompt_too_long",
      memory: {},
    });
    expect(first.recovered).toBe(true);

    const second = orchestrator.onReactiveRecovery({
      contextState: first.nextState,
      canonicalMessages: canonical,
      reason: "prompt_too_long",
      memory: {},
    });
    expect(second.recovered).toBe(false);
  });

  it("prepare should suppress auto compact for session-memory/internal compaction sources", () => {
    const orchestrator = new ContextOrchestrator({
      maxInputTokens: 800,
      thresholds: {
        warningBufferTokens: 0,
        autoCompactBufferTokens: 700,
        errorBufferTokens: 100,
        blockingHeadroomTokens: -10_000,
      },
    });
    const canonical = Array.from({ length: 20 }, (_, idx) =>
      makeRunMessage(idx, idx, `round-${idx}-${"x".repeat(300)}`),
    );

    const prepared = (
      orchestrator as unknown as {
        prepare(input: Record<string, unknown>): ReturnType<ContextOrchestrator["prepare"]>;
      }
    ).prepare({
      systemPrompt: "system",
      tools: noTools,
      apiView: canonical.map(toApiMessage),
      canonicalMessages: canonical,
      memory: {},
      contextState: initialContextRuntimeState(),
      querySource: "session_memory",
    });

    expect(prepared.nextState.compactBoundaries).toHaveLength(0);
    expect(
      prepared.nextState.lastLayerExecutions.some(
        (layer) => layer.layer === "session_memory_compact" || layer.layer === "auto_compact",
      ),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { ContextOrchestrator, initialContextRuntimeState } from "../../src/context";
import {
  listPreservedContextAssets,
  registerPreservedContextAsset,
  removePreservedContextAsset,
} from "../../src/context/preserved-context";
import type { RunMessage } from "../../src/message/types";

const makeMessage = (idx: number): RunMessage => ({
  id: `m_${idx}`,
  messageId: `msg_${idx}`,
  role: idx % 2 === 0 ? "user" : "assistant",
  content: `content-${idx}-${"x".repeat(120)}`,
  createdAt: new Date(1_700_000_000_000 + idx).toISOString(),
  source: "input",
  roundIndex: Math.floor(idx / 2),
});

describe("preserved context assets", () => {
  it("registers, lists, and removes preserved context assets", () => {
    let state = initialContextRuntimeState();
    state = registerPreservedContextAsset(state, {
      id: "asset_files",
      kind: "recent_files",
      content: "src/app.ts\nconst x = 1;",
      priority: 100,
    });
    state = registerPreservedContextAsset(state, {
      id: "asset_plan",
      kind: "plan",
      content: "1. write red test\n2. fix implementation",
      priority: 50,
    });

    expect(listPreservedContextAssets(state).map((asset) => asset.id)).toEqual([
      "asset_files",
      "asset_plan",
    ]);

    state = removePreservedContextAsset(state, "asset_files");
    expect(listPreservedContextAssets(state).map((asset) => asset.id)).toEqual(["asset_plan"]);
  });

  it("reinjects preserved context assets after compaction and records diagnostics", () => {
    const orchestrator = new ContextOrchestrator({
      maxInputTokens: 100,
      maxOutputTokens: 100,
      maxPromptTooLongRetries: 3,
      maxReactiveCompactAttempts: 3,
      maxCompactRequestRetries: 2,
      compactRequestMaxInputChars: 20_000,
      maxConsecutiveCompactFailures: 3,
      toolResultSoftCharLimit: 6_000,
      historySnipKeepRounds: 6,
      historySnipMaxDropRounds: 1,
      microcompactMaxToolChars: 500,
      collapseRestoreMaxMessages: 8,
      collapseRestoreTokenHeadroomRatio: 0.6,
      rehydrationTokenBudget: 300,
      recentFileBudgetTokens: 200,
      skillsRehydrateBudgetTokens: 100,
      thresholds: {
        warningBufferTokens: 0,
        autoCompactBufferTokens: 0,
        errorBufferTokens: 0,
        blockingHeadroomTokens: -10_000,
      },
    });
    const canonical = Array.from({ length: 18 }, (_, idx) => makeMessage(idx));
    const apiView = canonical.map(
      ({ messageId: _messageId, source: _source, ...message }) => message,
    );
    let state = initialContextRuntimeState();
    state = registerPreservedContextAsset(state, {
      id: "asset_recent_file",
      kind: "recent_files",
      content: "packages/agent/src/runtime/agent-runtime.ts\nconst resume = true;",
      priority: 100,
      budgetTokens: 120,
      allowTruncation: true,
    });
    state.sessionMemoryState = {
      notes:
        "# Session Title\n_Test_\n\n# Current State\n_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._\nRehydrate preserved files after compact.",
      initialized: true,
      tokensAtLastExtraction: 90,
    };

    const prepared = orchestrator.prepare({
      systemPrompt: "system",
      tools: [],
      apiView,
      canonicalMessages: canonical,
      memory: {},
      contextState: state,
    });

    expect(
      prepared.messages.some((message) =>
        message.content.includes("packages/agent/src/runtime/agent-runtime.ts"),
      ),
    ).toBe(true);
    expect(prepared.nextState.compactionDiagnostics?.length).toBeGreaterThan(0);
    expect(prepared.nextState.compactionDiagnostics?.at(-1)?.rehydratedAssetIds).toContain(
      "asset_recent_file",
    );
  });
});

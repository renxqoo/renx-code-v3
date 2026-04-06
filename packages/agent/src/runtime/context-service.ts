import type { ModelClient, ModelRequest, ToolDefinition } from "@renx/model";

import { formatCompactSummary, getCompactPrompt } from "../context/summary-prompt";
import { SessionMemoryService } from "../context/session-memory";
import { markPostCompactTurnStarted } from "../context/persistence";
import type { ContextRuntimeState, EffectiveRequestSnapshot } from "../context/types";
import { ContextOrchestrator } from "../context";
import type { DefaultMessageManager } from "../message/manager";
import type { AgentRunContext, AgentStatePatch, ContextLifecycleHooks } from "../types";

import { RuntimeAuditService } from "./audit-service";
import {
  getReactiveRecoveryReason,
  getResponseId,
  ModelRequestWithContextMetadata,
  toThresholdLevel,
} from "./utils";

type PatchState = (ctx: AgentRunContext, patch: AgentStatePatch) => AgentRunContext;

export class RuntimeContextService {
  constructor(
    private readonly contextOrchestrator: ContextOrchestrator,
    private readonly messageManager: DefaultMessageManager,
    private readonly modelClient: ModelClient,
    private readonly model: string,
    private readonly systemPrompt: string,
    private readonly sessionMemoryService: SessionMemoryService | undefined,
    private readonly patchState: PatchState,
    private readonly audit: RuntimeAuditService,
    private readonly lifecycleHooks: ContextLifecycleHooks | undefined,
  ) {}

  async prepareStepContext(
    ctx: AgentRunContext,
    toolDefs: ToolDefinition[],
    signal?: AbortSignal,
  ): Promise<{
    ctx: AgentRunContext;
    preparedContext: ReturnType<ContextOrchestrator["prepare"]>;
    modelRequest: ModelRequest;
  }> {
    ctx = await this.hydrateSessionMemoryIfNeeded(ctx);
    const effectiveMessages = this.messageManager.buildEffectiveMessages(ctx);
    const previousLayerCount = ctx.state.context?.lastLayerExecutions.length ?? 0;
    const querySource = getQuerySource(ctx);
    const budgetReason = this.shouldSignalBeforeCompact(ctx);
    if (budgetReason) {
      await this.lifecycleHooks?.beforeCompact?.({
        runId: ctx.state.runId,
        source: "prepare",
        reason: budgetReason,
        ...(querySource ? { querySource } : {}),
      });
    }
    const preparedContext = this.contextOrchestrator.prepare({
      systemPrompt: this.systemPrompt,
      tools: toolDefs,
      apiView: effectiveMessages,
      canonicalMessages: ctx.state.messages,
      memory: ctx.state.memory,
      ...(ctx.state.context ? { contextState: ctx.state.context } : {}),
      ...(querySource ? { querySource } : {}),
    });
    if (preparedContext.canonicalMessages) {
      ctx = this.patchState(ctx, { replaceMessages: preparedContext.canonicalMessages });
    }
    ctx = this.patchState(ctx, { setContext: preparedContext.nextState });
    ctx = await this.emitAfterCompactHooks(ctx, previousLayerCount);
    this.audit.emitContextPreparation(ctx, preparedContext.budget, previousLayerCount);

    let effectivePrepared = preparedContext;
    try {
      const refined = await this.refineAutoCompactSummaryIfNeeded(
        ctx,
        previousLayerCount,
        toolDefs,
      );
      ctx = refined.ctx;
      effectivePrepared = refined.preparedContext ?? preparedContext;
    } catch {
      this.audit.emit(ctx, {
        type: "context_layer_applied",
        payload: {
          layer: "auto_compact",
          tokensBefore: preparedContext.budget.estimatedInputTokens,
          tokensAfter: preparedContext.budget.estimatedInputTokens,
          reason: "compact_refine_failed_degraded",
        },
      });
    }

    const thresholdLevel = toThresholdLevel(effectivePrepared.budget);
    const contextManagement = buildContextManagement(querySource, thresholdLevel);
    const modelRequest: ModelRequest = {
      model: this.model,
      systemPrompt: this.systemPrompt,
      messages: effectivePrepared.messages,
      tools: toolDefs,
      ...(ctx.state.context?.forkedCachePrefix
        ? { metadata: { compactCachePrefix: ctx.state.context.forkedCachePrefix } }
        : {}),
      ...(signal ? { signal } : {}),
    };
    (modelRequest as ModelRequestWithContextMetadata).contextMetadata = {
      ...(effectivePrepared.nextState.lastProjectedApiViewId
        ? { apiViewId: effectivePrepared.nextState.lastProjectedApiViewId }
        : {}),
      ...(effectivePrepared.nextState.activeBoundaryId
        ? { compactBoundaryId: effectivePrepared.nextState.activeBoundaryId }
        : {}),
      thresholdLevel,
      ...(querySource ? { querySource } : {}),
      ...(contextManagement ? { contextManagement } : {}),
    };
    const contextMetadata = (modelRequest as ModelRequestWithContextMetadata).contextMetadata;
    const effectiveSnapshot: EffectiveRequestSnapshot = {
      capturedAt: new Date().toISOString(),
      systemPrompt: this.systemPrompt,
      messages: effectivePrepared.messages,
      toolNames: toolDefs.map((tool) => tool.name),
      ...(contextMetadata ? { contextMetadata: contextMetadata as Record<string, unknown> } : {}),
    };
    let nextContextState: ContextRuntimeState = {
      ...ctx.state.context!,
      lastEffectiveRequestSnapshot: effectiveSnapshot,
    };
    if (
      nextContextState.pendingPostCompactLifecycle &&
      !nextContextState.pendingPostCompactLifecycle.startedAt
    ) {
      const diagnostic = (nextContextState.compactionDiagnostics ?? []).find(
        (entry) =>
          entry.diagnosticId === nextContextState.pendingPostCompactLifecycle?.diagnosticId,
      );
      if (diagnostic) {
        await this.lifecycleHooks?.onPostCompactTurnStart?.({
          runId: ctx.state.runId,
          diagnostic,
        });
        nextContextState = markPostCompactTurnStarted(nextContextState);
      }
    }
    ctx = this.patchState(ctx, { setContext: nextContextState });

    return { ctx, preparedContext: effectivePrepared, modelRequest };
  }

  async tryRecoverFromModelError(
    ctx: AgentRunContext,
    error: unknown,
  ): Promise<{ recovered: false } | { recovered: true; ctx: AgentRunContext }> {
    const recoveryReason = getReactiveRecoveryReason(error);
    if (!recoveryReason) return { recovered: false };

    const querySource = getQuerySource(ctx);
    await this.lifecycleHooks?.beforeCompact?.({
      runId: ctx.state.runId,
      source: "recovery",
      reason: recoveryReason,
      ...(querySource ? { querySource } : {}),
    });
    const recovered = this.contextOrchestrator.onReactiveRecovery({
      canonicalMessages: ctx.state.messages,
      reason: recoveryReason,
      memory: ctx.state.memory,
      ...(ctx.state.context ? { contextState: ctx.state.context } : {}),
      ...(querySource ? { querySource } : {}),
    });
    if (!recovered.recovered) return { recovered: false };

    const nextCtx = this.patchState(ctx, {
      replaceMessages: recovered.canonicalMessages,
      setContext: recovered.nextState,
    });
    await this.emitAfterCompactHooks(
      nextCtx,
      ctx.state.context?.compactionDiagnostics?.length ?? 0,
    );
    this.audit.emit(nextCtx, {
      type: "context_recovery_retry",
      payload: { reason: recoveryReason, retryCount: recovered.nextState.promptTooLongRetries },
    });
    return { recovered: true, ctx: nextCtx };
  }

  private async refineAutoCompactSummaryIfNeeded(
    ctx: AgentRunContext,
    previousLayerCount: number,
    toolDefs: ToolDefinition[],
  ): Promise<{
    ctx: AgentRunContext;
    preparedContext?: ReturnType<ContextOrchestrator["prepare"]>;
  }> {
    const newLayers = (ctx.state.context?.lastLayerExecutions ?? []).slice(previousLayerCount);
    const hasNewCompactLayer = newLayers.some(
      (layer) =>
        layer.layer === "auto_compact" ||
        layer.layer === "session_memory_compact" ||
        layer.layer === "reactive_compact",
    );
    const summaryIndex = ctx.state.messages.findIndex((m) => m.id.startsWith("summary_"));
    if (summaryIndex < 0) return { ctx };

    const summaryMessage = ctx.state.messages[summaryIndex]!;
    const alreadyRefined = summaryMessage.metadata?.["compactRefined"] === true;
    if (!hasNewCompactLayer && alreadyRefined) return { ctx };

    const compactRequest: ModelRequest = {
      model: this.model,
      systemPrompt: "You are a helpful AI assistant tasked with summarizing conversations.",
      messages: [
        {
          id: `compact_req_${Date.now()}`,
          role: "user",
          content: `${getCompactPrompt()}\n\nConversation to summarize:\n${getCompactSummarySource(summaryMessage)}`,
          createdAt: new Date().toISOString(),
        },
      ],
      tools: [],
      metadata: {
        compactRefine: true,
        ...(ctx.state.context?.forkedCachePrefix
          ? { compactCachePrefix: ctx.state.context.forkedCachePrefix }
          : {}),
      },
      maxTokens: 1_500,
    };
    const compactResp = await this.modelClient.generate(compactRequest);
    if (compactResp.type !== "final") return { ctx };

    const nextMessages = [...ctx.state.messages];
    nextMessages[summaryIndex] = {
      ...summaryMessage,
      content: formatCompactSummary(compactResp.output),
      metadata: {
        ...summaryMessage.metadata,
        compactRefined: true,
      },
    };
    const baseContext = ctx.state.context;
    if (!baseContext) return { ctx };
    const compactResponseId = getResponseId(compactResp);
    const nextContext: ContextRuntimeState = {
      ...baseContext,
      ...(summaryMessage.preservedSegmentRef
        ? {
            preservedSegments: {
              ...baseContext.preservedSegments,
              [summaryMessage.preservedSegmentRef.segmentId]: {
                ...(baseContext.preservedSegments[summaryMessage.preservedSegmentRef.segmentId] ?? {
                  digest: summaryMessage.preservedSegmentRef.digest,
                  messageIds: [],
                  createdAt: new Date().toISOString(),
                }),
                summary: formatCompactSummary(compactResp.output),
              },
            },
          }
        : {}),
      ...(compactResponseId ? { lastSummaryResponseId: compactResponseId } : {}),
      ...(compactResponseId ? { forkedCachePrefix: compactResponseId } : {}),
    };
    ctx = this.patchState(ctx, {
      replaceMessages: nextMessages,
      setContext: nextContext,
    });

    const querySource = getQuerySource(ctx);
    const refreshed = this.contextOrchestrator.prepare({
      systemPrompt: this.systemPrompt,
      tools: toolDefs,
      apiView: this.messageManager.buildEffectiveMessages(ctx),
      canonicalMessages: ctx.state.messages,
      memory: ctx.state.memory,
      ...(ctx.state.context ? { contextState: ctx.state.context } : {}),
      ...(querySource ? { querySource } : {}),
    });
    ctx = this.patchState(ctx, {
      ...(refreshed.canonicalMessages ? { replaceMessages: refreshed.canonicalMessages } : {}),
      setContext: refreshed.nextState,
    });
    return { ctx, preparedContext: refreshed };
  }

  private async hydrateSessionMemoryIfNeeded(ctx: AgentRunContext): Promise<AgentRunContext> {
    if (!this.sessionMemoryService) return ctx;
    if (ctx.state.context?.sessionMemoryState?.notes) {
      return ctx;
    }
    return {
      ...ctx,
      state: await this.sessionMemoryService.hydrateState(ctx.state.runId, ctx.state, {
        waitForPendingExtraction: true,
      }),
    };
  }

  private shouldSignalBeforeCompact(ctx: AgentRunContext): string | null {
    const budget = ctx.state.context?.lastBudget;
    if (!budget) return null;
    if (budget.requiresAutoCompact) return "auto_compact_threshold";
    if (budget.shouldBlock) return "blocking_threshold";
    return null;
  }

  private async emitAfterCompactHooks(
    ctx: AgentRunContext,
    previousDiagnosticsLength: number,
  ): Promise<AgentRunContext> {
    const diagnostics = ctx.state.context?.compactionDiagnostics ?? [];
    if (diagnostics.length <= previousDiagnosticsLength) return ctx;
    const nextDiagnostics = diagnostics.slice(previousDiagnosticsLength);
    for (const diagnostic of nextDiagnostics) {
      await this.lifecycleHooks?.afterCompact?.({
        runId: ctx.state.runId,
        diagnostic,
      });
    }
    return ctx;
  }
}

const getQuerySource = (ctx: AgentRunContext): string | undefined => {
  const querySource = ctx.metadata?.["querySource"];
  return typeof querySource === "string" && querySource.length > 0 ? querySource : undefined;
};

const getCompactSummarySource = (summaryMessage: {
  content: string;
  metadata?: Record<string, unknown>;
}): string => {
  const compactSource = summaryMessage.metadata?.["compactSource"];
  return typeof compactSource === "string" && compactSource.trim().length > 0
    ? compactSource
    : summaryMessage.content;
};

const buildContextManagement = (
  querySource: string | undefined,
  thresholdLevel: "healthy" | "warning" | "auto_compact" | "error" | "blocking",
):
  | {
      edits: Array<
        | {
            type: "clear_tool_uses_20250919";
            trigger?: { type: "input_tokens"; value: number };
            clear_tool_inputs?: boolean | string[];
            exclude_tools?: string[];
            clear_at_least?: { type: "input_tokens"; value: number };
          }
        | {
            type: "clear_thinking_20251015";
            keep: { type: "thinking_turns"; value: number } | "all";
          }
      >;
    }
  | undefined => {
  const isMainThread =
    !querySource || querySource === "sdk" || querySource.startsWith("repl_main_thread");
  if (!isMainThread || thresholdLevel === "healthy") return undefined;

  return {
    edits: [
      {
        type: "clear_tool_uses_20250919",
        trigger: { type: "input_tokens", value: 180_000 },
        clear_at_least: { type: "input_tokens", value: 140_000 },
        clear_tool_inputs: [
          "bash",
          "read",
          "read_file",
          "grep",
          "glob",
          "web_fetch",
          "web_search",
          "shell",
        ],
      },
      {
        type: "clear_tool_uses_20250919",
        trigger: { type: "input_tokens", value: 180_000 },
        clear_at_least: { type: "input_tokens", value: 140_000 },
        exclude_tools: ["edit", "write", "notebook_edit"],
      },
    ],
  };
};

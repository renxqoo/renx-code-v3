import type { ModelClient, ModelRequest, ToolDefinition } from "@renx/model";

import { formatCompactSummary, getCompactPrompt } from "../context/summary-prompt";
import type { ContextRuntimeState } from "../context/types";
import { ContextOrchestrator } from "../context";
import type { DefaultMessageManager } from "../message/manager";
import type { AgentRunContext, AgentStatePatch } from "../types";

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
    private readonly patchState: PatchState,
    private readonly audit: RuntimeAuditService,
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
    const effectiveMessages = this.messageManager.buildEffectiveMessages(ctx);
    const previousLayerCount = ctx.state.context?.lastLayerExecutions.length ?? 0;
    const preparedContext = this.contextOrchestrator.prepare({
      systemPrompt: this.systemPrompt,
      tools: toolDefs,
      apiView: effectiveMessages,
      canonicalMessages: ctx.state.messages,
      memory: ctx.state.memory,
      ...(ctx.state.context ? { contextState: ctx.state.context } : {}),
    });
    if (preparedContext.canonicalMessages) {
      ctx = this.patchState(ctx, { replaceMessages: preparedContext.canonicalMessages });
    }
    ctx = this.patchState(ctx, { setContext: preparedContext.nextState });
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

    const modelRequest: ModelRequest = {
      model: this.model,
      systemPrompt: this.systemPrompt,
      messages: effectivePrepared.messages,
      tools: toolDefs,
      ...(signal ? { signal } : {}),
    };
    (modelRequest as ModelRequestWithContextMetadata).contextMetadata = {
      ...(effectivePrepared.nextState.lastProjectedApiViewId
        ? { apiViewId: effectivePrepared.nextState.lastProjectedApiViewId }
        : {}),
      ...(effectivePrepared.nextState.activeBoundaryId
        ? { compactBoundaryId: effectivePrepared.nextState.activeBoundaryId }
        : {}),
      thresholdLevel: toThresholdLevel(effectivePrepared.budget),
    };

    return { ctx, preparedContext: effectivePrepared, modelRequest };
  }

  tryRecoverFromModelError(
    ctx: AgentRunContext,
    error: unknown,
  ): { recovered: false } | { recovered: true; ctx: AgentRunContext } {
    const recoveryReason = getReactiveRecoveryReason(error);
    if (!recoveryReason) return { recovered: false };

    const recovered = this.contextOrchestrator.onReactiveRecovery({
      canonicalMessages: ctx.state.messages,
      reason: recoveryReason,
      memory: ctx.state.memory,
      ...(ctx.state.context ? { contextState: ctx.state.context } : {}),
    });
    if (!recovered.recovered) return { recovered: false };

    const nextCtx = this.patchState(ctx, {
      replaceMessages: recovered.canonicalMessages,
      setContext: recovered.nextState,
    });
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
          content: `${getCompactPrompt()}\n\nConversation to summarize:\n${summaryMessage.content}`,
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

    const refreshed = this.contextOrchestrator.prepare({
      systemPrompt: this.systemPrompt,
      tools: toolDefs,
      apiView: this.messageManager.buildEffectiveMessages(ctx),
      canonicalMessages: ctx.state.messages,
      memory: ctx.state.memory,
      ...(ctx.state.context ? { contextState: ctx.state.context } : {}),
    });
    ctx = this.patchState(ctx, {
      ...(refreshed.canonicalMessages ? { replaceMessages: refreshed.canonicalMessages } : {}),
      setContext: refreshed.nextState,
    });
    return { ctx, preparedContext: refreshed };
  }
}

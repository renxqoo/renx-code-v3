import { generateId } from "../helpers";
import type { AgentRunContext, AuditEvent, AuditLogger } from "../types";

export class RuntimeAuditService {
  constructor(private readonly audit: AuditLogger | undefined) {}

  emit(
    ctx: AgentRunContext,
    event: { type: AuditEvent["type"]; payload: Record<string, unknown> },
  ): void {
    if (!this.audit) return;
    this.audit.log({
      id: generateId(),
      runId: ctx.state.runId,
      ...event,
      timestamp: new Date().toISOString(),
    });
  }

  emitContextPreparation(
    ctx: AgentRunContext,
    budget: {
      estimatedInputTokens: number;
      warningThreshold: number;
      autoCompactThreshold: number;
      blockingThreshold: number;
      inWarning: boolean;
      requiresAutoCompact: boolean;
      shouldBlock: boolean;
    },
    previousLayerCount: number,
  ): void {
    this.emit(ctx, {
      type: "context_budget_measured",
      payload: {
        currentTokens: budget.estimatedInputTokens,
        warningThreshold: budget.warningThreshold,
        autoCompactThreshold: budget.autoCompactThreshold,
        blockingThreshold: budget.blockingThreshold,
      },
    });
    if (budget.inWarning) {
      this.emit(ctx, {
        type: "context_warning_entered",
        payload: { currentTokens: budget.estimatedInputTokens },
      });
    }
    if (budget.requiresAutoCompact) {
      this.emit(ctx, {
        type: "context_auto_compact_triggered",
        payload: { currentTokens: budget.estimatedInputTokens },
      });
    }
    if (budget.shouldBlock) {
      this.emit(ctx, {
        type: "context_blocking_triggered",
        payload: { currentTokens: budget.estimatedInputTokens },
      });
    }
    const layers = ctx.state.context?.lastLayerExecutions ?? [];
    for (const layer of layers.slice(previousLayerCount)) {
      this.emit(ctx, {
        type: "context_layer_applied",
        payload: {
          layer: layer.layer,
          tokensBefore: layer.beforeTokens,
          tokensAfter: layer.afterTokens,
          reason: layer.reason,
        },
      });
    }
  }
}

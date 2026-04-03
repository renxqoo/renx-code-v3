import type { ToolCall } from "@renx/model";

import { AgentError } from "../errors";
import { generateId } from "../helpers";
import { applyStatePatch } from "../state";
import type {
  AgentRunContext,
  AgentState,
  AgentStatePatch,
  ApprovalDecision,
  ApprovalTicket,
  PolicyEngine,
} from "../types";
import type { DefaultMessageManager } from "../message/manager";
import type { InMemoryToolRegistry } from "../tool/registry";
import type { AgentTool, ToolResult } from "../tool/types";
import type { TimelineManager } from "../timeline";

import type { RuntimeAuditService } from "./audit-service";

const PENDING_APPROVAL_SCRATCHPAD_KEY = "__pendingApproval";
const HANDLED_APPROVAL_TICKETS_SCRATCHPAD_KEY = "__handledApprovalTickets";
const APPROVAL_EXECUTION_CLAIMS_SCRATCHPAD_KEY = "__approvalExecutionClaims";

interface PendingApprovalState {
  ticket: ApprovalTicket;
  toolCall: ToolCall;
  toolAtomicGroupId: string;
  thinkingChunkGroupId: string;
}

type HandledApprovalTickets = Record<string, true>;
type ApprovalExecutionClaims = Record<string, true>;

type PatchState = (
  ctx: AgentRunContext,
  patch: AgentStatePatch,
  extraTransform?: (state: AgentState) => AgentState,
) => AgentRunContext;

export class RuntimeApprovalService {
  private readonly approvalTicketsInFlight = new Set<string>();
  private readonly approvalTicketsHandled = new Set<string>();

  constructor(
    private readonly timeline: TimelineManager,
    private readonly registry: InMemoryToolRegistry,
    private readonly policy: PolicyEngine,
    private readonly messageManager: DefaultMessageManager,
    private readonly patchState: PatchState,
    private readonly audit: RuntimeAuditService,
    private readonly executeToolCallInRun: (
      ctx: AgentRunContext,
      call: ToolCall,
      toolAtomicGroupId: string,
      thinkingChunkGroupId: string,
    ) => Promise<{ ctx: AgentRunContext; shouldStop: boolean; toolOutput?: ToolResult }>,
  ) {}

  async evaluateApprovalRequirement(
    ctx: AgentRunContext,
    tool: AgentTool,
    input: unknown,
  ): Promise<{
    required: boolean;
    reason?: string;
    expiresAt?: string;
    metadata?: Record<string, unknown>;
  }> {
    const engine = ctx.services.approvalEngine;
    if (!engine) return { required: false };
    const evaluation = await engine.evaluate(ctx, tool, input);
    if (!evaluation.required) return { required: false };
    return {
      required: true,
      ...(typeof evaluation.reason === "string" ? { reason: evaluation.reason } : {}),
      ...(typeof evaluation.expiresAt === "string" ? { expiresAt: evaluation.expiresAt } : {}),
      ...(evaluation.metadata ? { metadata: evaluation.metadata as Record<string, unknown> } : {}),
    };
  }

  async markWaitingApproval(
    ctx: AgentRunContext,
    call: ToolCall,
    toolAtomicGroupId: string,
    thinkingChunkGroupId: string,
    evaluation: {
      required: boolean;
      reason?: string;
      expiresAt?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<AgentRunContext> {
    const engine = ctx.services.approvalEngine;
    if (!engine) return ctx;
    const ticket: ApprovalTicket = {
      id: generateId("apt"),
      runId: ctx.state.runId,
      toolName: call.name,
      input: call.input,
      requestedAt: new Date().toISOString(),
      ...(evaluation.reason
        ? { reason: evaluation.reason }
        : { reason: `Tool "${call.name}" requires approval` }),
      ...(evaluation.expiresAt ? { expiresAt: evaluation.expiresAt } : {}),
      ...(evaluation.metadata ? { metadata: evaluation.metadata } : {}),
    };
    await engine.request(ctx, ticket);

    ctx = this.setPendingApproval(ctx, {
      ticket,
      toolCall: call,
      toolAtomicGroupId,
      thinkingChunkGroupId,
    });
    ctx = this.patchState(ctx, {}, (s) =>
      this.messageManager.appendAssistantMessage(
        s,
        `Operation "${call.name}" requires approval. Waiting for approval.`,
        ctx.state.context?.roundIndex,
      ),
    );
    ctx = this.patchState(ctx, { setStatus: "waiting_approval" });
    this.audit.emit(ctx, {
      type: "approval_requested",
      payload: { toolName: call.name, toolCallId: call.id, ticketId: ticket.id },
    });
    return ctx;
  }

  async resolvePendingApproval(ctx: AgentRunContext): Promise<{
    ctx: AgentRunContext;
    waiting: boolean;
    shouldStop: boolean;
    executedCall?: ToolCall;
    executedResult?: ToolResult;
  } | null> {
    const pending = this.getPendingApproval(ctx);
    if (!pending) return null;
    const ticketId = pending.ticket.id;
    if (this.approvalTicketsHandled.has(ticketId)) {
      return { ctx: this.setPendingApproval(ctx, null), waiting: false, shouldStop: false };
    }
    if (this.isApprovalTicketHandled(ctx.state, ticketId)) {
      this.approvalTicketsHandled.add(ticketId);
      return { ctx: this.setPendingApproval(ctx, null), waiting: false, shouldStop: false };
    }
    const latest = await this.timeline.load(ctx.state.runId);
    if (latest && this.isApprovalTicketHandled(latest.state, ticketId)) {
      this.approvalTicketsHandled.add(ticketId);
      return { ctx: this.setPendingApproval(ctx, null), waiting: false, shouldStop: false };
    }
    if (latest && this.isApprovalExecutionClaimed(latest.state, ticketId)) {
      return {
        ctx: this.patchState(ctx, { setStatus: "waiting_approval" }),
        waiting: true,
        shouldStop: true,
      };
    }
    if (this.approvalTicketsInFlight.has(ticketId)) {
      return {
        ctx: this.patchState(ctx, { setStatus: "waiting_approval" }),
        waiting: true,
        shouldStop: true,
      };
    }
    const engine = ctx.services.approvalEngine;
    if (!engine) {
      return {
        ctx: this.patchState(ctx, {
          setStatus: "failed",
          setError: new AgentError({
            code: "SYSTEM_ERROR",
            message: "ApprovalEngine is required to resume waiting approval state",
          }),
        }),
        waiting: false,
        shouldStop: true,
      };
    }

    const expiresAtMs =
      typeof pending.ticket.expiresAt === "string" ? Date.parse(pending.ticket.expiresAt) : NaN;
    const expiredByTime = Number.isFinite(expiresAtMs) && Date.now() >= expiresAtMs;
    const decision: ApprovalDecision | null = expiredByTime
      ? {
          ticketId,
          status: "expired",
        }
      : await engine.getDecision(ctx, ticketId);
    if (!decision) {
      return {
        ctx: this.patchState(ctx, { setStatus: "waiting_approval" }),
        waiting: true,
        shouldStop: true,
      };
    }
    if (decision.ticketId !== ticketId) {
      throw new AgentError({
        code: "SYSTEM_ERROR",
        message: `Approval decision ticket mismatch: expected ${ticketId}, got ${decision.ticketId}`,
      });
    }
    if (decision.status === "pending") {
      return {
        ctx: this.patchState(ctx, { setStatus: "waiting_approval" }),
        waiting: true,
        shouldStop: true,
      };
    }

    this.audit.emit(ctx, {
      type: "approval_resolved",
      payload: {
        ticketId: decision.ticketId,
        status: decision.status,
        reviewerId: decision.reviewerId,
      },
    });
    ctx = this.setPendingApproval(ctx, null);

    if (decision.status !== "approved") {
      ctx = this.patchState(ctx, {}, (s) =>
        this.messageManager.appendAssistantMessage(
          s,
          `Operation "${pending.toolCall.name}" approval ${decision.status}.`,
          ctx.state.context?.roundIndex,
        ),
      );
      ctx = this.patchState(ctx, {
        setStatus: "failed",
        setError: new AgentError({
          code: "APPROVAL_REQUIRED",
          message: `Tool approval not granted: ${pending.toolCall.name}`,
          metadata: {
            toolName: pending.toolCall.name,
            toolCallId: pending.toolCall.id,
            ticketId: decision.ticketId,
            status: decision.status,
            ...(decision.reviewerId ? { reviewerId: decision.reviewerId } : {}),
            ...(decision.comment ? { comment: decision.comment } : {}),
          },
        }),
      });
      return { ctx, waiting: false, shouldStop: true };
    }

    const tool = this.registry.get(pending.toolCall.name);
    if (!tool) {
      throw new AgentError({
        code: "TOOL_NOT_FOUND",
        message: `Tool not found: ${pending.toolCall.name}`,
        metadata: { toolName: pending.toolCall.name, toolCallId: pending.toolCall.id },
      });
    }
    const canUse = await this.policy.canUseTool(ctx, tool, pending.toolCall.input);
    if (!canUse) {
      throw new AgentError({
        code: "POLICY_DENIED",
        message: `Tool use denied by policy: ${pending.toolCall.name}`,
        metadata: { toolName: pending.toolCall.name, toolCallId: pending.toolCall.id },
      });
    }

    const claim = await this.claimApprovalExecution(ctx, ticketId);
    if (claim === "already_handled") {
      this.approvalTicketsHandled.add(ticketId);
      return { ctx: this.setPendingApproval(ctx, null), waiting: false, shouldStop: false };
    }
    if (claim === "claimed_by_other") {
      return {
        ctx: this.patchState(ctx, { setStatus: "waiting_approval" }),
        waiting: true,
        shouldStop: true,
      };
    }
    ctx = this.setApprovalExecutionClaim(ctx, ticketId, true);
    this.approvalTicketsInFlight.add(ticketId);
    let execution: { ctx: AgentRunContext; shouldStop: boolean; toolOutput?: ToolResult };
    try {
      execution = await this.executeToolCallInRun(
        ctx,
        pending.toolCall,
        pending.toolAtomicGroupId,
        pending.thinkingChunkGroupId,
      );
    } finally {
      this.approvalTicketsInFlight.delete(ticketId);
    }
    execution.ctx = this.setApprovalExecutionClaim(execution.ctx, ticketId, false);
    this.approvalTicketsHandled.add(ticketId);
    const nextCtx = this.markApprovalTicketHandled(execution.ctx, ticketId);
    return {
      ctx: nextCtx,
      waiting: false,
      shouldStop: execution.shouldStop,
      executedCall: pending.toolCall,
      ...(execution.toolOutput ? { executedResult: execution.toolOutput } : {}),
    };
  }

  private getPendingApproval(ctx: AgentRunContext): PendingApprovalState | null {
    const value = ctx.state.scratchpad[PENDING_APPROVAL_SCRATCHPAD_KEY];
    if (typeof value !== "object" || value === null) return null;
    const maybe = value as Record<string, unknown>;
    const ticket = maybe["ticket"];
    const toolAtomicGroupId = maybe["toolAtomicGroupId"];
    const thinkingChunkGroupId = maybe["thinkingChunkGroupId"];
    const toolCall = maybe["toolCall"];
    if (typeof toolAtomicGroupId !== "string" || typeof thinkingChunkGroupId !== "string")
      return null;
    if (typeof ticket !== "object" || ticket === null) return null;
    const rawTicket = ticket as Record<string, unknown>;
    if (
      typeof rawTicket["id"] !== "string" ||
      typeof rawTicket["runId"] !== "string" ||
      typeof rawTicket["toolName"] !== "string" ||
      !("input" in rawTicket) ||
      typeof rawTicket["requestedAt"] !== "string"
    ) {
      return null;
    }
    if (typeof toolCall !== "object" || toolCall === null) return null;
    const call = toolCall as Record<string, unknown>;
    if (typeof call["id"] !== "string" || typeof call["name"] !== "string" || !("input" in call))
      return null;
    return {
      ticket: {
        id: rawTicket["id"],
        runId: rawTicket["runId"],
        toolName: rawTicket["toolName"],
        input: rawTicket["input"],
        requestedAt: rawTicket["requestedAt"],
        ...(typeof rawTicket["reason"] === "string" ? { reason: rawTicket["reason"] } : {}),
        ...(typeof rawTicket["expiresAt"] === "string"
          ? { expiresAt: rawTicket["expiresAt"] }
          : {}),
        ...(typeof rawTicket["metadata"] === "object" && rawTicket["metadata"] !== null
          ? { metadata: rawTicket["metadata"] as Record<string, unknown> }
          : {}),
      },
      toolAtomicGroupId,
      thinkingChunkGroupId,
      toolCall: {
        id: call["id"],
        name: call["name"],
        input: call["input"],
      },
    };
  }

  private setPendingApproval(
    ctx: AgentRunContext,
    pending: PendingApprovalState | null,
  ): AgentRunContext {
    if (pending) {
      return this.patchState(ctx, {
        setScratchpad: { [PENDING_APPROVAL_SCRATCHPAD_KEY]: pending },
      });
    }
    return this.patchState(ctx, { setScratchpad: { [PENDING_APPROVAL_SCRATCHPAD_KEY]: null } });
  }

  private getHandledApprovalTickets(state: AgentState): HandledApprovalTickets {
    const value = state.scratchpad[HANDLED_APPROVAL_TICKETS_SCRATCHPAD_KEY];
    if (typeof value !== "object" || value === null) return {};
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v === true);
    return Object.fromEntries(entries) as HandledApprovalTickets;
  }

  private isApprovalTicketHandled(state: AgentState, ticketId: string): boolean {
    return this.getHandledApprovalTickets(state)[ticketId] === true;
  }

  private markApprovalTicketHandled(ctx: AgentRunContext, ticketId: string): AgentRunContext {
    const handled = this.getHandledApprovalTickets(ctx.state);
    return this.patchState(ctx, {
      setScratchpad: {
        [HANDLED_APPROVAL_TICKETS_SCRATCHPAD_KEY]: {
          ...handled,
          [ticketId]: true,
        },
      },
    });
  }

  private getApprovalExecutionClaims(state: AgentState): ApprovalExecutionClaims {
    const value = state.scratchpad[APPROVAL_EXECUTION_CLAIMS_SCRATCHPAD_KEY];
    if (typeof value !== "object" || value === null) return {};
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v === true);
    return Object.fromEntries(entries) as ApprovalExecutionClaims;
  }

  private isApprovalExecutionClaimed(state: AgentState, ticketId: string): boolean {
    return this.getApprovalExecutionClaims(state)[ticketId] === true;
  }

  private setApprovalExecutionClaim(
    ctx: AgentRunContext,
    ticketId: string,
    claimed: boolean,
  ): AgentRunContext {
    const claims = this.getApprovalExecutionClaims(ctx.state);
    const nextClaims = { ...claims };
    if (claimed) nextClaims[ticketId] = true;
    else delete nextClaims[ticketId];
    return this.patchState(ctx, {
      setScratchpad: {
        [APPROVAL_EXECUTION_CLAIMS_SCRATCHPAD_KEY]: nextClaims,
      },
    });
  }

  private async claimApprovalExecution(
    ctx: AgentRunContext,
    ticketId: string,
  ): Promise<"claimed" | "already_handled" | "claimed_by_other"> {
    const latest = await this.timeline.load(ctx.state.runId);
    if (!latest) return "claimed";
    if (this.isApprovalTicketHandled(latest.state, ticketId)) return "already_handled";
    if (this.isApprovalExecutionClaimed(latest.state, ticketId)) return "claimed_by_other";

    const result = await this.timeline.casUpdate(ctx.state.runId, (current) => {
      if (this.isApprovalTicketHandled(current.state, ticketId)) return null;
      if (this.isApprovalExecutionClaimed(current.state, ticketId)) return null;
      return applyStatePatch(current.state, {
        setScratchpad: {
          [APPROVAL_EXECUTION_CLAIMS_SCRATCHPAD_KEY]: {
            ...this.getApprovalExecutionClaims(current.state),
            [ticketId]: true,
          },
        },
      });
    });
    if (result === "updated") return "claimed";
    if (result === "conflict") return "claimed_by_other";

    const after = await this.timeline.load(ctx.state.runId);
    if (after && this.isApprovalTicketHandled(after.state, ticketId)) return "already_handled";
    if (after && this.isApprovalExecutionClaimed(after.state, ticketId)) return "claimed_by_other";
    return "claimed_by_other";
  }
}

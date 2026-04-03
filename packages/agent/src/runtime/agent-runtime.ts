import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  ToolCall,
  ToolDefinition,
} from "@renx/model";

import { AgentError } from "../errors";
import { generateId, isTerminalStatus } from "../helpers";
import { applyStatePatch } from "../state";
import type {
  AgentRunContext,
  AgentResult,
  AgentState,
  AgentStatePatch,
  AgentStreamEvent,
  PolicyEngine,
} from "../types";
import { DefaultMessageManager } from "../message/manager";
import { InMemoryToolRegistry } from "../tool/registry";
import { ToolExecutor } from "../tool/executor";
import { MiddlewarePipeline } from "../middleware/pipeline";
import type { AgentTool, ToolResult } from "../tool/types";
import { AllowAllPolicy } from "../policy";
import { ContextOrchestrator } from "../context";
import { TimelineManager } from "../timeline";

import type { RuntimeConfig } from "./config";
import { RuntimeAuditService } from "./audit-service";
import { RuntimeModelService } from "./model-service";
import { RuntimeContextService } from "./context-service";
import { RuntimeApprovalService } from "./approval-service";
import { getResponseId, getResponseUsage, toToolInputSchema } from "./utils";

type StepFlow = "continue" | "break";
type RunStepResult = { ctx: AgentRunContext; flow: StepFlow };
type StreamStepResult = { ctx: AgentRunContext; flow: StepFlow };
type PreStepGateResult =
  | { ctx: AgentRunContext; proceed: true }
  | {
      ctx: AgentRunContext;
      proceed: false;
      flow: StepFlow;
      resumedCall?: ToolCall;
      resumedResult?: ToolResult;
    };

/**
 * Core execution engine for an agent run.
 */
export class AgentRuntime {
  private readonly modelClient: ModelClient;
  private readonly model: string;
  private readonly toolList: AgentTool[];
  private readonly pipeline: MiddlewarePipeline;
  private readonly messageManager: DefaultMessageManager;
  private readonly maxSteps: number;
  private readonly toolExecutor: ToolExecutor;
  private readonly registry: InMemoryToolRegistry;
  private readonly timeline: TimelineManager;
  private readonly policy: PolicyEngine;
  private readonly contextOrchestrator: ContextOrchestrator;
  private readonly modelService: RuntimeModelService;
  private readonly contextService: RuntimeContextService;
  private readonly approvalService: RuntimeApprovalService;
  private readonly auditService: RuntimeAuditService;

  constructor(private readonly config: RuntimeConfig) {
    this.modelClient = config.modelClient;
    this.model = config.model;
    this.toolList = config.tools;
    this.pipeline = config.pipeline ?? new MiddlewarePipeline();
    this.messageManager = config.messageManager ?? new DefaultMessageManager();
    this.policy = config.policy ?? new AllowAllPolicy();
    this.timeline = new TimelineManager(config.timeline, {
      mode: config.timelineMode ?? "default",
      ...(config.timelineParentNodeId ? { parentNodeId: config.timelineParentNodeId } : {}),
    });
    this.maxSteps = config.maxSteps;
    const modelMaxRetries = Math.max(0, config.retry?.modelMaxRetries ?? 1);
    const retryBaseDelayMs = Math.max(0, config.retry?.retryBaseDelayMs ?? 50);
    const retryMaxDelayMs = Math.max(0, config.retry?.retryMaxDelayMs ?? 500);

    this.registry = new InMemoryToolRegistry();
    for (const tool of this.toolList) {
      this.registry.register(tool);
    }
    this.toolExecutor = new ToolExecutor(
      this.registry,
      this.pipeline,
      config.backendResolver,
      config.audit,
      {
        toolMaxRetries: config.retry?.toolMaxRetries ?? 1,
        retryBaseDelayMs,
        retryMaxDelayMs,
      },
    );

    this.auditService = new RuntimeAuditService(config.audit);
    this.modelService = new RuntimeModelService(
      this.modelClient,
      modelMaxRetries,
      retryBaseDelayMs,
      retryMaxDelayMs,
    );
    this.contextOrchestrator = new ContextOrchestrator(config.context);
    this.contextService = new RuntimeContextService(
      this.contextOrchestrator,
      this.messageManager,
      this.modelClient,
      this.model,
      config.systemPrompt,
      (ctx, patch) => this.patchState(ctx, patch),
      this.auditService,
    );
    this.approvalService = new RuntimeApprovalService(
      this.timeline,
      this.registry,
      this.policy,
      this.messageManager,
      (ctx, patch, extraTransform) => this.patchState(ctx, patch, extraTransform),
      this.auditService,
      (ctx, call, toolAtomicGroupId, thinkingChunkGroupId) =>
        this.executeToolCallInRun(ctx, call, toolAtomicGroupId, thinkingChunkGroupId),
    );
  }

  async run(ctx: AgentRunContext): Promise<AgentResult> {
    try {
      // 阶段 1: 初始化上下文
      ctx = await this.runInitialize(ctx);

      // 阶段 2: 循环推进状态机
      while (ctx.state.status === "running") {
        const step = await this.runExecuteStep(ctx);
        ctx = step.ctx;
        if (step.flow === "continue") continue;
        break;
      }

      // 阶段 3: 成功路径收尾
      return await this.runFinalizeSuccess(ctx);
    } catch (error) {
      // 阶段 4: 异常路径收尾
      return await this.runFinalizeFailure(ctx, error);
    }
  }

  private async runInitialize(ctx: AgentRunContext): Promise<AgentRunContext> {
    const incoming = this.messageManager.normalizeIncoming(ctx.input);
    for (const msg of incoming) {
      ctx = this.patchState(ctx, { appendMessages: [msg] });
    }
    await this.pipeline.runBeforeRun(ctx);
    if (ctx.state.stepCount === 0) await this.saveTimelineSnapshot(ctx.state);

    this.auditService.emit(ctx, {
      type: "run_started",
      payload: { stepCount: 0, inputType: ctx.input.inputText ? "text" : "messages" },
    });
    return ctx;
  }

  private async runExecuteStep(ctx: AgentRunContext): Promise<RunStepResult> {
    const preStep = await this.stepPrecheck(ctx);
    ctx = preStep.ctx;
    if (!preStep.proceed) {
      return { ctx, flow: preStep.flow };
    }

    const preparedTurn = await this.prepareModelTurn(ctx);
    ctx = preparedTurn.ctx;
    if (preparedTurn.blocked) {
      return { ctx, flow: "break" };
    }

    let modelResponse: ModelResponse;
    try {
      modelResponse = await this.modelService.generateWithRetry(preparedTurn.modelRequest);
    } catch (error) {
      const recovered = this.contextService.tryRecoverFromModelError(ctx, error);
      if (recovered.recovered) {
        return { ctx: recovered.ctx, flow: "continue" };
      }
      throw error;
    }

    const applied = await this.applyModelResponse(
      ctx,
      modelResponse,
      preparedTurn.preparedContext.budget.estimatedInputTokens,
      preparedTurn.preparedStep.modelRequest.messages.length,
    );
    ctx = applied.ctx;
    modelResponse = applied.modelResponse;

    if (modelResponse.type === "final") {
      const finalHandled = await this.handleFinalResponse(ctx, modelResponse);
      ctx = finalHandled.ctx;
      return { ctx, flow: finalHandled.shouldContinue ? "continue" : "break" };
    }

    if (modelResponse.type === "tool_calls") {
      const toolsHandled = await this.handleToolCalls(ctx, modelResponse.toolCalls);
      ctx = toolsHandled.ctx;
      return { ctx, flow: toolsHandled.shouldStop ? "break" : "continue" };
    }

    ctx = this.patchState(ctx, {}, (s) =>
      this.messageManager.appendAssistantMessage(
        s,
        (modelResponse as { output?: string }).output ?? "",
        ctx.state.context?.roundIndex,
      ),
    );
    ctx = this.patchState(ctx, {
      setStatus: "failed",
      setError: new AgentError({
        code: "SYSTEM_ERROR",
        message: `Unexpected model response type: ${(modelResponse as { type: string }).type}`,
      }),
    });
    return { ctx, flow: "break" };
  }

  private async runFinalizeSuccess(ctx: AgentRunContext): Promise<AgentResult> {
    const result = this.buildResultFromState(ctx.state);

    await this.pipeline.runAfterRun(ctx, result);
    await this.saveTimelineSnapshot(ctx.state);
    this.emitTerminalAudit(ctx);
    return result;
  }

  private async runFinalizeFailure(ctx: AgentRunContext, error: unknown): Promise<AgentResult> {
    const agentError =
      error instanceof AgentError
        ? error
        : new AgentError({
            code: "SYSTEM_ERROR",
            message: error instanceof Error ? error.message : "Unknown error",
            cause: error,
          });

    ctx = {
      ...ctx,
      state: applyStatePatch(ctx.state, { setStatus: "failed", setError: agentError }),
    };
    const failedResult = this.buildResultFromState(ctx.state, { includeOutput: false });
    await this.pipeline.runOnError(ctx, agentError);
    try {
      await this.pipeline.runAfterRun(ctx, failedResult);
    } catch {
      // Keep original failure.
    }
    await this.saveTimelineSnapshot(ctx.state);
    this.auditService.emit(ctx, {
      type: "run_failed",
      payload: { code: agentError.code, message: agentError.message },
    });
    return failedResult;
  }

  async *stream(ctx: AgentRunContext): AsyncGenerator<AgentStreamEvent, AgentResult> {
    try {
      // 阶段 1: 初始化上下文
      const initialized = await this.streamInitialize(ctx);
      ctx = initialized.ctx;
      yield initialized.startedEvent;

      // 阶段 2: 循环推进状态机
      while (ctx.state.status === "running") {
        const step = yield* this.streamExecuteStep(ctx);
        ctx = step.ctx;
        if (step.flow === "continue") continue;
        break;
      }

      // 阶段 3: 成功路径收尾
      const finalized = await this.streamFinalizeSuccess(ctx);
      for (const event of finalized.events) {
        yield event;
      }
      return finalized.result;
    } catch (error) {
      // 阶段 4: 异常路径收尾
      const failedResult = await this.runFinalizeFailure(ctx, error);
      if (failedResult.error) {
        yield { type: "run_failed", error: failedResult.error };
      }
      return failedResult;
    }
  }

  private async streamInitialize(ctx: AgentRunContext): Promise<{
    ctx: AgentRunContext;
    startedEvent: Extract<AgentStreamEvent, { type: "run_started" }>;
  }> {
    const nextCtx = await this.runInitialize(ctx);
    return {
      ctx: nextCtx,
      startedEvent: { type: "run_started", runId: nextCtx.state.runId },
    };
  }

  private async *streamExecuteStep(
    ctx: AgentRunContext,
  ): AsyncGenerator<AgentStreamEvent, StreamStepResult> {
    if (ctx.input.signal?.aborted) {
      ctx = this.patchState(ctx, { setStatus: "interrupted" });
      return { ctx, flow: "break" };
    }

    const preStep = await this.stepPrecheck(ctx);
    ctx = preStep.ctx;
    if (!preStep.proceed) {
      if (preStep.resumedCall && preStep.resumedResult) {
        yield { type: "tool_call", call: preStep.resumedCall };
        yield { type: "tool_result", result: preStep.resumedResult };
      }
      return { ctx, flow: preStep.flow };
    }

    const preparedTurn = await this.prepareModelTurn(ctx, ctx.input.signal);
    ctx = preparedTurn.ctx;
    if (preparedTurn.blocked) {
      return { ctx, flow: "break" };
    }

    yield { type: "model_started" };
    let streamResult: { response: ModelResponse };
    try {
      streamResult = yield* this.modelService.consumeModelStreamWithRetry(
        preparedTurn.modelRequest,
        ctx,
      );
    } catch (error) {
      const recovered = this.contextService.tryRecoverFromModelError(ctx, error);
      if (recovered.recovered) {
        return { ctx: recovered.ctx, flow: "continue" };
      }
      throw error;
    }

    let modelResponse = streamResult.response;
    const applied = await this.applyModelResponse(
      ctx,
      modelResponse,
      preparedTurn.preparedContext.budget.estimatedInputTokens,
      preparedTurn.preparedStep.modelRequest.messages.length,
    );
    ctx = applied.ctx;
    modelResponse = applied.modelResponse;

    if (modelResponse.type === "final") {
      const finalHandled = await this.handleFinalResponse(ctx, modelResponse);
      ctx = finalHandled.ctx;
      return { ctx, flow: finalHandled.shouldContinue ? "continue" : "break" };
    }

    if (modelResponse.type === "tool_calls") {
      const toolsHandled = await this.handleToolCalls(ctx, modelResponse.toolCalls, {
        ...(ctx.input.signal ? { abortSignal: ctx.input.signal } : {}),
        collectStreamEvents: true,
      });
      ctx = toolsHandled.ctx;
      for (const event of toolsHandled.events) {
        yield event;
      }
      return { ctx, flow: toolsHandled.shouldStop ? "break" : "continue" };
    }

    ctx = this.patchState(ctx, {
      setStatus: "failed",
      setError: new AgentError({
        code: "SYSTEM_ERROR",
        message: "Unexpected model response type",
      }),
    });
    return { ctx, flow: "break" };
  }

  private async streamFinalizeSuccess(
    ctx: AgentRunContext,
  ): Promise<{ result: AgentResult; events: AgentStreamEvent[] }> {
    const result = await this.runFinalizeSuccess(ctx);
    const events: AgentStreamEvent[] = [];
    if (result.status === "completed") {
      events.push({ type: "run_completed", output: result.output ?? "" });
    } else if (result.error) {
      events.push({ type: "run_failed", error: result.error });
    }
    return { result, events };
  }

  private buildResultFromState(
    state: AgentState,
    options?: { includeOutput?: boolean },
  ): AgentResult {
    const result: AgentResult = { runId: state.runId, status: state.status, state };
    if ((options?.includeOutput ?? true) && state.lastModelResponse?.type === "final") {
      result.output = state.lastModelResponse.output;
    }
    if (state.error) result.error = state.error;
    return result;
  }

  private emitTerminalAudit(ctx: AgentRunContext): void {
    this.auditService.emit(ctx, {
      type:
        isTerminalStatus(ctx.state.status) && ctx.state.status === "completed"
          ? "run_completed"
          : "run_failed",
      payload: { stepCount: ctx.state.stepCount, messageCount: ctx.state.messages.length },
    });
  }

  private async stepPrecheck(ctx: AgentRunContext): Promise<PreStepGateResult> {
    ctx = { ...ctx, state: { ...ctx.state, stepCount: ctx.state.stepCount + 1 } };
    if (ctx.state.stepCount > this.maxSteps) {
      ctx = this.patchState(ctx, {
        setStatus: "failed",
        setError: new AgentError({
          code: "MAX_STEPS_EXCEEDED",
          message: `Agent exceeded maximum steps (${this.maxSteps})`,
        }),
      });
      return { ctx, proceed: false, flow: "break" };
    }

    const pendingApproval = await this.approvalService.resolvePendingApproval(ctx);
    if (!pendingApproval) {
      return { ctx, proceed: true };
    }

    ctx = pendingApproval.ctx;
    if (pendingApproval.waiting || pendingApproval.shouldStop) {
      await this.saveTimelineSnapshot(ctx.state);
      return { ctx, proceed: false, flow: "break" };
    }
    if (pendingApproval.executedResult) {
      await this.saveTimelineSnapshot(ctx.state);
    }
    return {
      ctx,
      proceed: false,
      flow: "continue",
      ...(pendingApproval.executedCall ? { resumedCall: pendingApproval.executedCall } : {}),
      ...(pendingApproval.executedResult ? { resumedResult: pendingApproval.executedResult } : {}),
    };
  }

  private async prepareModelTurn(
    ctx: AgentRunContext,
    signal?: AbortSignal,
  ): Promise<
    | { blocked: true; ctx: AgentRunContext }
    | {
        blocked: false;
        ctx: AgentRunContext;
        preparedStep: Awaited<ReturnType<RuntimeContextService["prepareStepContext"]>>;
        preparedContext: Awaited<
          ReturnType<RuntimeContextService["prepareStepContext"]>
        >["preparedContext"];
        modelRequest: ModelRequest;
      }
  > {
    const allowedTools = await this.policy.filterTools(ctx, this.toolList);
    const toolDefs: ToolDefinition[] = allowedTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: toToolInputSchema(t.schema),
    }));

    const preparedStep = await this.contextService.prepareStepContext(ctx, toolDefs, signal);
    ctx = preparedStep.ctx;
    const preparedContext = preparedStep.preparedContext;
    if (preparedContext.budget.shouldBlock) {
      ctx = this.patchState(ctx, {
        setStatus: "failed",
        setError: new AgentError({
          code: "CONTEXT_OVERFLOW",
          message: "Context budget exceeded blocking threshold",
          metadata: {
            estimatedInputTokens: preparedContext.budget.estimatedInputTokens,
            blockingThreshold: preparedContext.budget.blockingThreshold,
          },
        }),
      });
      return { blocked: true, ctx };
    }

    let modelRequest: ModelRequest = preparedStep.modelRequest;
    modelRequest = await this.pipeline.runBeforeModel(ctx, modelRequest);
    this.auditService.emit(ctx, {
      type: "model_called",
      payload: {
        stepCount: ctx.state.stepCount,
        messageCount: modelRequest.messages.length,
        toolCount: modelRequest.tools.length,
        estimatedInputTokens: preparedContext.budget.estimatedInputTokens,
      },
    });
    return { blocked: false, ctx, preparedStep, preparedContext, modelRequest };
  }

  private async applyModelResponse(
    ctx: AgentRunContext,
    modelResponse: ModelResponse,
    estimatedInputTokens: number,
    messageCount: number,
  ): Promise<{ ctx: AgentRunContext; modelResponse: ModelResponse }> {
    this.auditService.emit(ctx, {
      type: "model_returned",
      payload: { stepCount: ctx.state.stepCount, responseType: modelResponse.type },
    });
    modelResponse = await this.pipeline.runAfterModel(ctx, modelResponse);
    const nextContextState = this.contextOrchestrator.onModelResponse({
      response: modelResponse,
      estimatedInputTokens,
      messageCount,
      ...(ctx.state.context ? { contextState: ctx.state.context } : {}),
    });
    ctx = {
      ...ctx,
      state: { ...ctx.state, lastModelResponse: modelResponse, context: nextContextState },
    };
    this.auditService.emit(ctx, {
      type: "context_usage_snapshot_updated",
      payload: {
        inputTokens: getResponseUsage(modelResponse)?.inputTokens,
        outputTokens: getResponseUsage(modelResponse)?.outputTokens,
        responseId: getResponseId(modelResponse),
      },
    });
    return { ctx, modelResponse };
  }

  private async handleFinalResponse(
    ctx: AgentRunContext,
    modelResponse: Extract<ModelResponse, { type: "final" }>,
  ): Promise<{ ctx: AgentRunContext; shouldContinue: boolean }> {
    const finalDecision = await this.pipeline.runAfterAssistantFinal(ctx, modelResponse);
    for (const patch of finalDecision.statePatch) {
      ctx = this.patchState(ctx, patch);
    }
    if (finalDecision.continueWithUserMessage) {
      ctx = this.patchState(ctx, {}, (s) =>
        this.messageManager.appendUserMessage(s, finalDecision.continueWithUserMessage!),
      );
      await this.saveTimelineSnapshot(ctx.state);
      return { ctx, shouldContinue: true };
    }
    ctx = this.patchState(ctx, {}, (s) =>
      this.messageManager.appendAssistantMessage(
        s,
        modelResponse.output,
        ctx.state.context?.roundIndex,
      ),
    );
    ctx = this.patchState(ctx, { setStatus: "completed" });
    return { ctx, shouldContinue: false };
  }

  private async handleToolCalls(
    ctx: AgentRunContext,
    toolCalls: ToolCall[],
    options?: { abortSignal?: AbortSignal; collectStreamEvents?: boolean },
  ): Promise<{ ctx: AgentRunContext; shouldStop: boolean; events: AgentStreamEvent[] }> {
    const events: AgentStreamEvent[] = [];
    const toolAtomicGroupId = generateId("ag");
    const thinkingChunkGroupId = generateId("th");
    ctx = this.patchState(ctx, {}, (s) =>
      this.messageManager.appendAssistantToolCallMessage(
        s,
        "",
        toolCalls,
        ctx.state.context?.roundIndex,
        toolAtomicGroupId,
        thinkingChunkGroupId,
      ),
    );

    let shouldStop = false;
    for (const call of toolCalls) {
      if (options?.abortSignal?.aborted) {
        shouldStop = true;
        break;
      }

      const tool = this.registry.get(call.name);
      if (!tool) {
        if (options?.collectStreamEvents) {
          events.push({ type: "tool_call", call });
        }
        const missingOutput = this.buildMissingToolResult(call);
        let outputContent = missingOutput.content;
        if (this.policy.redactOutput) {
          const redacted = await this.policy.redactOutput(ctx, outputContent);
          if (redacted !== undefined) {
            outputContent = redacted;
          }
        }
        const outputForMessage: ToolResult = { ...missingOutput, content: outputContent };
        ctx = this.patchState(ctx, {}, (s) =>
          this.messageManager.appendToolResultMessage(
            s,
            call.name,
            call.id,
            outputForMessage.content,
            ctx.state.context?.roundIndex,
            toolAtomicGroupId,
            thinkingChunkGroupId,
          ),
        );
        ctx = {
          ...ctx,
          state: {
            ...ctx.state,
            lastToolCall: call,
            lastToolResult: outputForMessage,
          },
        };
        this.auditService.emit(ctx, {
          type: "tool_failed",
          payload: {
            toolName: call.name,
            toolCallId: call.id,
            code: "TOOL_NOT_FOUND",
            message: `Tool not found: ${call.name}`,
          },
        });
        if (options?.collectStreamEvents) {
          events.push({ type: "tool_result", result: outputForMessage });
        }
        await this.saveTimelineSnapshot(ctx.state);
        continue;
      }
      const canUse = await this.policy.canUseTool(ctx, tool, call.input);
      if (!canUse) {
        throw new AgentError({
          code: "POLICY_DENIED",
          message: `Tool use denied by policy: ${call.name}`,
          metadata: { toolName: call.name, toolCallId: call.id },
        });
      }
      const approvalEval = await this.approvalService.evaluateApprovalRequirement(
        ctx,
        tool,
        call.input,
      );
      if (approvalEval.required) {
        ctx = await this.approvalService.markWaitingApproval(
          ctx,
          call,
          toolAtomicGroupId,
          thinkingChunkGroupId,
          approvalEval,
        );
        await this.saveTimelineSnapshot(ctx.state);
        shouldStop = true;
        break;
      }

      if (options?.collectStreamEvents) {
        events.push({ type: "tool_call", call });
      }
      const execution = await this.executeToolCallInRun(
        ctx,
        call,
        toolAtomicGroupId,
        thinkingChunkGroupId,
      );
      ctx = execution.ctx;
      if (options?.collectStreamEvents && execution.toolOutput) {
        events.push({ type: "tool_result", result: execution.toolOutput });
      }
      await this.saveTimelineSnapshot(ctx.state);
      if (execution.shouldStop) {
        shouldStop = true;
        break;
      }
    }

    return { ctx, shouldStop, events };
  }

  private async executeToolCallInRun(
    ctx: AgentRunContext,
    call: ToolCall,
    toolAtomicGroupId: string,
    thinkingChunkGroupId: string,
  ): Promise<{ ctx: AgentRunContext; shouldStop: boolean; toolOutput?: ToolResult }> {
    this.auditService.emit(ctx, {
      type: "tool_called",
      payload: { stepCount: ctx.state.stepCount, toolName: call.name, toolCallId: call.id },
    });

    const execResult = await this.toolExecutor.run(call, ctx);
    if (execResult.type === "stopped") {
      for (const patch of execResult.statePatches) {
        ctx = this.patchState(ctx, patch);
      }
      return { ctx, shouldStop: true };
    }

    const { result: toolResult } = execResult;
    for (const patch of execResult.statePatches) {
      ctx = this.patchState(ctx, patch);
    }
    if (toolResult.output.statePatch) {
      ctx = this.patchState(ctx, toolResult.output.statePatch);
    }

    let outputContent = toolResult.output.content;
    if (this.policy.redactOutput) {
      const redacted = await this.policy.redactOutput(ctx, outputContent);
      if (redacted !== undefined) {
        outputContent = redacted;
      }
    }

    ctx = this.patchState(ctx, {}, (s) =>
      this.messageManager.appendToolResultMessage(
        s,
        toolResult.tool.name,
        toolResult.call.id,
        outputContent,
        ctx.state.context?.roundIndex,
        toolAtomicGroupId,
        thinkingChunkGroupId,
      ),
    );
    ctx = {
      ...ctx,
      state: {
        ...ctx.state,
        lastToolCall: call,
        lastToolResult: toolResult.output,
      },
    };

    const isErrorResult =
      (toolResult.output.metadata?.["ok"] === false ||
        toolResult.output.metadata?.["errorCode"] !== undefined) ??
      false;
    this.auditService.emit(ctx, {
      type: isErrorResult ? "tool_failed" : "tool_succeeded",
      payload: isErrorResult
        ? {
            toolName: call.name,
            toolCallId: call.id,
            code: toolResult.output.metadata?.["errorCode"] ?? "TOOL_ERROR",
            message: "Tool execution returned error payload",
          }
        : { toolName: call.name, toolCallId: call.id },
    });
    return { ctx, shouldStop: execResult.shouldStop, toolOutput: toolResult.output };
  }

  private patchState(
    ctx: AgentRunContext,
    patch: AgentStatePatch,
    extraTransform?: (state: AgentState) => AgentState,
  ): AgentRunContext {
    let state = applyStatePatch(ctx.state, patch);
    if (extraTransform) {
      state = extraTransform(state);
    }
    return { ...ctx, state };
  }

  private async saveTimelineSnapshot(state: AgentState): Promise<void> {
    await this.timeline.save(state.runId, state);
  }

  private buildMissingToolResult(call: ToolCall): ToolResult {
    const structured = {
      ok: false,
      error: {
        code: "TOOL_NOT_FOUND",
        message: `Tool not found: ${call.name}`,
        details: { toolName: call.name, toolCallId: call.id },
      },
    };
    return {
      content: JSON.stringify(structured),
      structured,
      metadata: {
        ok: false,
        errorCode: "TOOL_NOT_FOUND",
        toolName: call.name,
        toolCallId: call.id,
      },
    };
  }
}

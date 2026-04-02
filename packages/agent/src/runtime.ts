import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  ToolCall,
  ToolDefinition,
} from "@renx/model";
import { zodToJsonSchema } from "zod-to-json-schema";

import { AgentError } from "./errors";
import { generateId, isTerminalStatus } from "./helpers";
import { applyStatePatch } from "./state";
import type {
  AgentStatePatch,
  AgentRunContext,
  AgentResult,
  AgentState,
  AgentStreamEvent,
  AuditEvent,
  AuditLogger,
  CheckpointStore,
  PolicyEngine,
} from "./types";
import { DefaultMessageManager } from "./message/manager";
import { InMemoryToolRegistry } from "./tool/registry";
import { ToolExecutor } from "./tool/executor";
import { MiddlewarePipeline } from "./middleware/pipeline";
import type { AgentTool, BackendResolver } from "./tool/types";
import { AllowAllPolicy } from "./policy";
import { ContextOrchestrator } from "./context";
import { formatCompactSummary, getCompactPrompt } from "./context/summary-prompt";
import type { ContextManagerConfig, ContextRuntimeState } from "./context/types";

const toToolInputSchema = (schema: AgentTool["schema"]): Record<string, unknown> => {
  try {
    return zodToJsonSchema(schema, { target: "openAi" }) as Record<string, unknown>;
  } catch {
    return { type: "object", properties: {} };
  }
};

export interface RuntimeConfig {
  name: string;
  modelClient: ModelClient;
  model: string;
  tools: AgentTool[];
  pipeline?: MiddlewarePipeline;
  messageManager?: DefaultMessageManager;
  policy?: PolicyEngine;
  checkpoint?: CheckpointStore;
  audit?: AuditLogger;
  systemPrompt: string;
  maxSteps: number;
  backendResolver?: BackendResolver;
  context?: Partial<ContextManagerConfig>;
  retry?: {
    modelMaxRetries?: number;
    toolMaxRetries?: number;
    retryBaseDelayMs?: number;
    retryMaxDelayMs?: number;
  };
}

/**
 * Core execution engine for an agent run.
 *
 * Runtime owns:
 * - The main inference loop
 * - State machine transitions
 * - Checkpoint save points
 * - Error handling
 * - Middleware lifecycle dispatch
 */
export class AgentRuntime {
  private readonly modelClient: ModelClient;
  private readonly model: string;
  private readonly toolList: AgentTool[];
  private readonly pipeline: MiddlewarePipeline;
  private readonly messageManager: DefaultMessageManager;
  private readonly policy: PolicyEngine;
  private readonly checkpoint: CheckpointStore | undefined;
  private readonly audit: AuditLogger | undefined;
  private readonly systemPrompt: string;
  private readonly maxSteps: number;
  private readonly modelMaxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly toolExecutor: ToolExecutor;
  private readonly registry: InMemoryToolRegistry;
  private readonly contextOrchestrator: ContextOrchestrator;

  /** Track first checkpoint createdAt for resume. */
  private firstCreatedAt: string | undefined;

  constructor(config: RuntimeConfig) {
    this.modelClient = config.modelClient;
    this.model = config.model;
    this.toolList = config.tools;
    this.pipeline = config.pipeline ?? new MiddlewarePipeline();
    this.messageManager = config.messageManager ?? new DefaultMessageManager();
    this.policy = config.policy ?? new AllowAllPolicy();
    this.checkpoint = config.checkpoint;
    this.audit = config.audit;
    this.systemPrompt = config.systemPrompt;
    this.maxSteps = config.maxSteps;
    this.modelMaxRetries = Math.max(0, config.retry?.modelMaxRetries ?? 1);
    this.retryBaseDelayMs = Math.max(0, config.retry?.retryBaseDelayMs ?? 50);
    this.retryMaxDelayMs = Math.max(0, config.retry?.retryMaxDelayMs ?? 500);

    this.registry = new InMemoryToolRegistry();
    for (const tool of this.toolList) {
      this.registry.register(tool);
    }

    this.toolExecutor = new ToolExecutor(
      this.registry,
      this.pipeline,
      config.backendResolver,
      this.audit,
      {
        toolMaxRetries: config.retry?.toolMaxRetries ?? 1,
        retryBaseDelayMs: this.retryBaseDelayMs,
        retryMaxDelayMs: this.retryMaxDelayMs,
      },
    );
    this.contextOrchestrator = new ContextOrchestrator(config.context);
  }

  async run(ctx: AgentRunContext): Promise<AgentResult> {
    try {
      // --- Phase 1: Initialize ---

      // Normalize and append incoming messages
      const incoming = this.messageManager.normalizeIncoming(ctx.input);
      for (const msg of incoming) {
        ctx = this.patchState(ctx, { appendMessages: [msg] });
      }

      // Run beforeRun middleware
      await this.pipeline.runBeforeRun(ctx);

      // Save initial checkpoint
      await this.saveCheckpoint(ctx.state);

      this.emitAudit(ctx, {
        type: "run_started",
        payload: { stepCount: 0, inputType: ctx.input.inputText ? "text" : "messages" },
      });

      // --- Phase 2: Main Loop ---

      while (ctx.state.status === "running") {
        // Step budget check
        ctx = { ...ctx, state: { ...ctx.state, stepCount: ctx.state.stepCount + 1 } };

        if (ctx.state.stepCount > this.maxSteps) {
          ctx = this.patchState(ctx, {
            setStatus: "failed",
            setError: new AgentError({
              code: "MAX_STEPS_EXCEEDED",
              message: `Agent exceeded maximum steps (${this.maxSteps})`,
            }),
          });
          break;
        }

        // Filter tools via policy
        const allowedTools = await this.policy.filterTools(ctx, this.toolList);

        // Convert to ToolDefinition for the model
        const toolDefs: ToolDefinition[] = allowedTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: toToolInputSchema(t.schema),
        }));

        const preparedStep = await this.prepareStepContext(ctx, toolDefs);
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
          break;
        }

        // Build model request
        let modelRequest: ModelRequest = preparedStep.modelRequest;

        // Run beforeModel middleware
        modelRequest = await this.pipeline.runBeforeModel(ctx, modelRequest);

        // Call model
        this.emitAudit(ctx, {
          type: "model_called",
          payload: {
            stepCount: ctx.state.stepCount,
            messageCount: modelRequest.messages.length,
            toolCount: modelRequest.tools.length,
            estimatedInputTokens: preparedContext.budget.estimatedInputTokens,
          },
        });

        let modelResponse: ModelResponse;
        try {
          modelResponse = await this.generateWithRetry(modelRequest);
        } catch (error) {
          const recovered = this.tryRecoverFromModelError(ctx, error);
          if (recovered.recovered) {
            ctx = recovered.ctx;
            continue;
          }
          throw error;
        }

        this.emitAudit(ctx, {
          type: "model_returned",
          payload: { stepCount: ctx.state.stepCount, responseType: modelResponse.type },
        });

        // Run afterModel middleware
        modelResponse = await this.pipeline.runAfterModel(ctx, modelResponse);

        // Track last model response
        const nextContextState = this.contextOrchestrator.onModelResponse({
          response: modelResponse,
          estimatedInputTokens: preparedContext.budget.estimatedInputTokens,
          messageCount: preparedStep.modelRequest.messages.length,
          ...(ctx.state.context ? { contextState: ctx.state.context } : {}),
        });
        ctx = {
          ...ctx,
          state: { ...ctx.state, lastModelResponse: modelResponse, context: nextContextState },
        };
        this.emitAudit(ctx, {
          type: "context_usage_snapshot_updated",
          payload: {
            inputTokens: getResponseUsage(modelResponse)?.inputTokens,
            outputTokens: getResponseUsage(modelResponse)?.outputTokens,
            responseId: getResponseId(modelResponse),
          },
        });

        // --- Branch: Final answer ---
        if (modelResponse.type === "final") {
          ctx = this.patchState(ctx, {}, (s) =>
            this.messageManager.appendAssistantMessage(
              s,
              modelResponse.output,
              ctx.state.context?.roundIndex,
            ),
          );
          ctx = this.patchState(ctx, { setStatus: "completed" });
          break;
        }

        // --- Branch: Tool calls ---
        if (modelResponse.type === "tool_calls") {
          const toolAtomicGroupId = generateId("ag");
          const thinkingChunkGroupId = generateId("th");
          // Record assistant tool-call message
          ctx = this.patchState(ctx, {}, (s) =>
            this.messageManager.appendAssistantToolCallMessage(
              s,
              "",
              modelResponse.toolCalls,
              ctx.state.context?.roundIndex,
              toolAtomicGroupId,
              thinkingChunkGroupId,
            ),
          );

          // Process each tool call
          let shouldStop = false;
          for (const call of modelResponse.toolCalls) {
            const tool = this.registry.get(call.name);
            if (!tool) {
              throw new AgentError({
                code: "TOOL_NOT_FOUND",
                message: `Tool not found: ${call.name}`,
                metadata: { toolName: call.name, toolCallId: call.id },
              });
            }

            // Policy check
            const canUse = await this.policy.canUseTool(ctx, tool, call.input);
            if (!canUse) {
              throw new AgentError({
                code: "POLICY_DENIED",
                message: `Tool use denied by policy: ${call.name}`,
                metadata: { toolName: call.name, toolCallId: call.id },
              });
            }

            // Approval check
            const needApproval = await this.policy.needApproval?.(ctx, tool, call.input);
            if (needApproval) {
              if (ctx.services.approval) {
                await ctx.services.approval.create({
                  id: generateId(),
                  runId: ctx.state.runId,
                  toolName: call.name,
                  input: call.input,
                  reason: `Tool "${call.name}" requires approval`,
                  createdAt: new Date().toISOString(),
                });
              }

              ctx = this.patchState(ctx, {}, (s) =>
                this.messageManager.appendAssistantMessage(
                  s,
                  `Operation "${call.name}" requires approval. Waiting for approval.`,
                  ctx.state.context?.roundIndex,
                ),
              );
              ctx = this.patchState(ctx, { setStatus: "waiting_approval" });

              this.emitAudit(ctx, {
                type: "approval_requested",
                payload: { toolName: call.name, toolCallId: call.id },
              });

              await this.saveCheckpoint(ctx.state);
              shouldStop = true;
              break;
            }

            this.emitAudit(ctx, {
              type: "tool_called",
              payload: { stepCount: ctx.state.stepCount, toolName: call.name, toolCallId: call.id },
            });

            // Execute tool
            const execResult = await this.toolExecutor.run(call, ctx);

            if (execResult.type === "stopped") {
              // Apply any middleware state patches from stopped path
              for (const patch of execResult.statePatches) {
                ctx = this.patchState(ctx, patch);
              }
              shouldStop = true;
              break;
            }

            const { result: toolResult } = execResult;

            // Apply middleware state patches from executor
            for (const patch of execResult.statePatches) {
              ctx = this.patchState(ctx, patch);
            }

            // Apply state patch from tool result
            if (toolResult.output.statePatch) {
              ctx = this.patchState(ctx, toolResult.output.statePatch);
            }

            // Redact output via policy
            let outputContent = toolResult.output.content;
            if (this.policy.redactOutput) {
              const redacted = await this.policy.redactOutput(ctx, outputContent);
              if (redacted !== undefined) {
                outputContent = redacted;
              }
            }

            // Append tool result message
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

            // Track last tool info
            ctx = {
              ...ctx,
              state: {
                ...ctx.state,
                lastToolCall: call,
                lastToolResult: toolResult.output,
              },
            };

            this.emitAudit(ctx, {
              type: "tool_succeeded",
              payload: { toolName: call.name, toolCallId: call.id },
            });

            // Checkpoint after each tool
            await this.saveCheckpoint(ctx.state);

            if (execResult.shouldStop) {
              shouldStop = true;
              break;
            }
          }

          if (shouldStop) break;

          // Continue loop for next model call
          continue;
        }

        // --- Branch: Unknown response type ---
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
        break;
      }

      // --- Phase 3: Finalize ---

      const result: AgentResult = {
        runId: ctx.state.runId,
        status: ctx.state.status,
        state: ctx.state,
      };

      if (ctx.state.lastModelResponse?.type === "final") {
        result.output = ctx.state.lastModelResponse.output;
      }
      if (ctx.state.error) {
        result.error = ctx.state.error;
      }

      // Run afterRun middleware
      await this.pipeline.runAfterRun(ctx, result);

      // Save final checkpoint
      await this.saveCheckpoint(ctx.state);

      this.emitAudit(ctx, {
        type:
          isTerminalStatus(ctx.state.status) && ctx.state.status === "completed"
            ? "run_completed"
            : "run_failed",
        payload: {
          stepCount: ctx.state.stepCount,
          messageCount: ctx.state.messages.length,
        },
      });

      return result;
    } catch (error) {
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
        state: applyStatePatch(ctx.state, {
          setStatus: "failed",
          setError: agentError,
        }),
      };

      const failedResult: AgentResult = {
        runId: ctx.state.runId,
        status: "failed",
        error: agentError,
        state: ctx.state,
      };
      await this.pipeline.runOnError(ctx, agentError);
      try {
        await this.pipeline.runAfterRun(ctx, failedResult);
      } catch {
        // Preserve the original failure if failure-finalization middleware breaks.
      }
      await this.saveCheckpoint(ctx.state);

      this.emitAudit(ctx, {
        type: "run_failed",
        payload: { code: agentError.code, message: agentError.message },
      });

      return failedResult;
    }
  }

  /**
   * Streaming variant of run().
   *
   * Uses modelClient.stream() for real token-level streaming.
   * Yields assistant_delta per token, tool_call_delta for incremental tool args,
   * and all other agent-level lifecycle events.
   */
  async *stream(ctx: AgentRunContext): AsyncGenerator<AgentStreamEvent, AgentResult> {
    try {
      const incoming = this.messageManager.normalizeIncoming(ctx.input);
      for (const msg of incoming) {
        ctx = this.patchState(ctx, { appendMessages: [msg] });
      }

      await this.pipeline.runBeforeRun(ctx);
      await this.saveCheckpoint(ctx.state);
      this.emitAudit(ctx, {
        type: "run_started",
        payload: { stepCount: 0, inputType: ctx.input.inputText ? "text" : "messages" },
      });

      yield { type: "run_started", runId: ctx.state.runId };

      while (ctx.state.status === "running") {
        // Check abort signal
        if (ctx.input.signal?.aborted) {
          ctx = this.patchState(ctx, { setStatus: "interrupted" });
          break;
        }

        ctx = { ...ctx, state: { ...ctx.state, stepCount: ctx.state.stepCount + 1 } };

        if (ctx.state.stepCount > this.maxSteps) {
          ctx = this.patchState(ctx, {
            setStatus: "failed",
            setError: new AgentError({
              code: "MAX_STEPS_EXCEEDED",
              message: `Agent exceeded maximum steps (${this.maxSteps})`,
            }),
          });
          break;
        }

        const allowedTools = await this.policy.filterTools(ctx, this.toolList);
        const toolDefs: ToolDefinition[] = allowedTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: toToolInputSchema(t.schema),
        }));

        const preparedStep = await this.prepareStepContext(ctx, toolDefs, ctx.input.signal);
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
          break;
        }

        let modelRequest: ModelRequest = preparedStep.modelRequest;

        modelRequest = await this.pipeline.runBeforeModel(ctx, modelRequest);

        yield { type: "model_started" };

        this.emitAudit(ctx, {
          type: "model_called",
          payload: {
            stepCount: ctx.state.stepCount,
            messageCount: modelRequest.messages.length,
            toolCount: modelRequest.tools.length,
            estimatedInputTokens: preparedContext.budget.estimatedInputTokens,
          },
        });

        // --- Real streaming: consume model token stream ---
        let streamResult: { response: ModelResponse };
        try {
          streamResult = yield* this.consumeModelStreamWithRetry(modelRequest, ctx);
        } catch (error) {
          const recovered = this.tryRecoverFromModelError(ctx, error);
          if (recovered.recovered) {
            ctx = recovered.ctx;
            continue;
          }
          throw error;
        }
        let modelResponse = streamResult.response;

        this.emitAudit(ctx, {
          type: "model_returned",
          payload: { stepCount: ctx.state.stepCount, responseType: modelResponse.type },
        });

        modelResponse = await this.pipeline.runAfterModel(ctx, modelResponse);
        const nextContextState = this.contextOrchestrator.onModelResponse({
          response: modelResponse,
          estimatedInputTokens: preparedContext.budget.estimatedInputTokens,
          messageCount: preparedStep.modelRequest.messages.length,
          ...(ctx.state.context ? { contextState: ctx.state.context } : {}),
        });
        ctx = {
          ...ctx,
          state: { ...ctx.state, lastModelResponse: modelResponse, context: nextContextState },
        };
        this.emitAudit(ctx, {
          type: "context_usage_snapshot_updated",
          payload: {
            inputTokens: getResponseUsage(modelResponse)?.inputTokens,
            outputTokens: getResponseUsage(modelResponse)?.outputTokens,
            responseId: getResponseId(modelResponse),
          },
        });

        // --- Branch: Final answer ---
        if (modelResponse.type === "final") {
          ctx = this.patchState(ctx, {}, (s) =>
            this.messageManager.appendAssistantMessage(
              s,
              modelResponse.output,
              ctx.state.context?.roundIndex,
            ),
          );
          ctx = this.patchState(ctx, { setStatus: "completed" });
          break;
        }

        // --- Branch: Tool calls ---
        if (modelResponse.type === "tool_calls") {
          const toolAtomicGroupId = generateId("ag");
          const thinkingChunkGroupId = generateId("th");
          ctx = this.patchState(ctx, {}, (s) =>
            this.messageManager.appendAssistantToolCallMessage(
              s,
              "",
              modelResponse.toolCalls,
              ctx.state.context?.roundIndex,
              toolAtomicGroupId,
              thinkingChunkGroupId,
            ),
          );

          let shouldStop = false;
          for (const call of modelResponse.toolCalls) {
            if (ctx.input.signal?.aborted) {
              shouldStop = true;
              break;
            }

            const tool = this.registry.get(call.name);
            if (!tool) {
              throw new AgentError({
                code: "TOOL_NOT_FOUND",
                message: `Tool not found: ${call.name}`,
                metadata: { toolName: call.name, toolCallId: call.id },
              });
            }

            const canUse = await this.policy.canUseTool(ctx, tool, call.input);
            if (!canUse) {
              throw new AgentError({
                code: "POLICY_DENIED",
                message: `Tool use denied by policy: ${call.name}`,
                metadata: { toolName: call.name, toolCallId: call.id },
              });
            }

            yield { type: "tool_call", call };

            const execResult = await this.toolExecutor.run(call, ctx);

            if (execResult.type === "stopped") {
              for (const patch of execResult.statePatches) {
                ctx = this.patchState(ctx, patch);
              }
              shouldStop = true;
              break;
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
              if (redacted !== undefined) outputContent = redacted;
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
              state: { ...ctx.state, lastToolCall: call, lastToolResult: toolResult.output },
            };

            yield { type: "tool_result", result: toolResult.output };

            await this.saveCheckpoint(ctx.state);

            if (execResult.shouldStop) {
              shouldStop = true;
              break;
            }
          }

          if (shouldStop) break;
          continue;
        }

        // Unknown response type
        ctx = this.patchState(ctx, {
          setStatus: "failed",
          setError: new AgentError({
            code: "SYSTEM_ERROR",
            message: `Unexpected model response type`,
          }),
        });
        break;
      }

      // Finalize
      const result: AgentResult = {
        runId: ctx.state.runId,
        status: ctx.state.status,
        state: ctx.state,
      };
      if (ctx.state.lastModelResponse?.type === "final")
        result.output = ctx.state.lastModelResponse.output;
      if (ctx.state.error) result.error = ctx.state.error;

      await this.pipeline.runAfterRun(ctx, result);
      await this.saveCheckpoint(ctx.state);
      this.emitAudit(ctx, {
        type:
          isTerminalStatus(result.status) && result.status === "completed"
            ? "run_completed"
            : "run_failed",
        payload: {
          stepCount: ctx.state.stepCount,
          messageCount: ctx.state.messages.length,
        },
      });

      if (result.status === "completed") {
        yield { type: "run_completed", output: result.output ?? "" };
      } else if (result.error) {
        yield { type: "run_failed", error: result.error };
      }

      return result;
    } catch (error) {
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
      const failedResult: AgentResult = {
        runId: ctx.state.runId,
        status: "failed",
        error: agentError,
        state: ctx.state,
      };
      await this.pipeline.runOnError(ctx, agentError);
      try {
        await this.pipeline.runAfterRun(ctx, failedResult);
      } catch {
        // Preserve the original failure if failure-finalization middleware breaks.
      }
      await this.saveCheckpoint(ctx.state);
      this.emitAudit(ctx, {
        type: "run_failed",
        payload: { code: agentError.code, message: agentError.message },
      });

      yield { type: "run_failed", error: agentError };
      return failedResult;
    }
  }

  /**
   * Consume a real model token stream.
   *
   * Yields assistant_delta per text token and tool_call_delta for incremental args.
   * Collects complete text and tool calls, then returns a synthetic ModelResponse.
   */
  private async *consumeModelStream(
    modelRequest: ModelRequest,
    _ctx: AgentRunContext,
  ): AsyncGenerator<AgentStreamEvent, { response: ModelResponse }> {
    let textBuffer = "";
    const toolCalls: ToolCall[] = [];
    let responseId: string | undefined;
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    let iteration: Record<string, unknown> | undefined;

    for await (const event of this.modelClient.stream(modelRequest)) {
      switch (event.type) {
        case "text_delta":
          textBuffer += event.text;
          yield { type: "assistant_delta", text: event.text };
          break;

        case "tool_call_delta":
          yield { type: "tool_call_delta", partial: event.partial };
          break;

        case "tool_call":
          toolCalls.push(event.call);
          break;

        case "done":
          responseId = getDoneEventResponseId(event);
          usage = getDoneEventUsage(event);
          iteration = getDoneEventIteration(event);
          break;
      }
    }

    // Build synthetic ModelResponse from accumulated stream data
    const response: ModelResponse =
      toolCalls.length > 0
        ? {
            type: "tool_calls",
            toolCalls,
            ...(responseId ? { responseId } : {}),
            ...(usage ? { usage } : {}),
            ...(iteration ? { iteration } : {}),
          }
        : {
            type: "final",
            output: textBuffer,
            ...(responseId ? { responseId } : {}),
            ...(usage ? { usage } : {}),
            ...(iteration ? { iteration } : {}),
          };

    return { response };
  }

  private async *consumeModelStreamWithRetry(
    modelRequest: ModelRequest,
    ctx: AgentRunContext,
  ): AsyncGenerator<AgentStreamEvent, { response: ModelResponse }> {
    let attempts = 0;
    while (true) {
      try {
        return yield* this.consumeModelStream(modelRequest, ctx);
      } catch (error) {
        const shouldRetry = this.shouldRetryModelError(error) && attempts < this.modelMaxRetries;
        if (!shouldRetry) throw error;
        attempts += 1;
        await sleep(computeBackoffMs(attempts, this.retryBaseDelayMs, this.retryMaxDelayMs));
      }
    }
  }

  private async generateWithRetry(modelRequest: ModelRequest): Promise<ModelResponse> {
    let attempts = 0;
    while (true) {
      try {
        return await this.modelClient.generate(modelRequest);
      } catch (error) {
        const shouldRetry = this.shouldRetryModelError(error) && attempts < this.modelMaxRetries;
        if (!shouldRetry) throw error;
        attempts += 1;
        await sleep(computeBackoffMs(attempts, this.retryBaseDelayMs, this.retryMaxDelayMs));
      }
    }
  }

  // --- Helpers ---

  private async prepareStepContext(
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
    this.emitContextPreparationAudit(ctx, preparedContext.budget, previousLayerCount);

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
      this.emitAudit(ctx, {
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

  private tryRecoverFromModelError(
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
    this.emitAudit(nextCtx, {
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

  private async saveCheckpoint(state: AgentState): Promise<void> {
    if (!this.checkpoint) return;
    const now = new Date().toISOString();
    if (!this.firstCreatedAt) {
      this.firstCreatedAt = now;
    }
    await this.checkpoint.save({
      runId: state.runId,
      state,
      createdAt: this.firstCreatedAt,
      updatedAt: now,
    });
  }

  private emitAudit(
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

  private emitContextPreparationAudit(
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
    this.emitAudit(ctx, {
      type: "context_budget_measured",
      payload: {
        currentTokens: budget.estimatedInputTokens,
        warningThreshold: budget.warningThreshold,
        autoCompactThreshold: budget.autoCompactThreshold,
        blockingThreshold: budget.blockingThreshold,
      },
    });
    if (budget.inWarning) {
      this.emitAudit(ctx, {
        type: "context_warning_entered",
        payload: { currentTokens: budget.estimatedInputTokens },
      });
    }
    if (budget.requiresAutoCompact) {
      this.emitAudit(ctx, {
        type: "context_auto_compact_triggered",
        payload: { currentTokens: budget.estimatedInputTokens },
      });
    }
    if (budget.shouldBlock) {
      this.emitAudit(ctx, {
        type: "context_blocking_triggered",
        payload: { currentTokens: budget.estimatedInputTokens },
      });
    }
    const layers = ctx.state.context?.lastLayerExecutions ?? [];
    for (const layer of layers.slice(previousLayerCount)) {
      this.emitAudit(ctx, {
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

  private shouldRetryModelError(error: unknown): boolean {
    if (error instanceof AgentError) return error.retryable;
    if (!error || typeof error !== "object") return false;
    const maybe = error as { retryable?: unknown; status?: unknown; code?: unknown };
    if (maybe.retryable === true) return true;
    if (typeof maybe.status === "number" && (maybe.status === 429 || maybe.status >= 500))
      return true;
    return maybe.code === "MODEL_ERROR";
  }
}

const getReactiveRecoveryReason = (
  error: unknown,
): "prompt_too_long" | "media_too_large" | "context_overflow" | "max_output_tokens" | null => {
  if (!error || typeof error !== "object") return null;
  const maybe = error as { code?: unknown; rawType?: unknown; message?: unknown };
  if (maybe.code === "CONTEXT_OVERFLOW") return "context_overflow";
  if (maybe.code !== "INVALID_REQUEST") return null;
  const rawType = typeof maybe.rawType === "string" ? maybe.rawType.toLowerCase() : "";
  const message = typeof maybe.message === "string" ? maybe.message.toLowerCase() : "";
  if (rawType.includes("media") || message.includes("media too large")) return "media_too_large";
  if (
    rawType.includes("context_length") ||
    rawType.includes("context_window") ||
    rawType.includes("token_limit") ||
    message.includes("context length") ||
    message.includes("context window") ||
    message.includes("too many tokens") ||
    message.includes("input is too long")
  ) {
    return "context_overflow";
  }
  if (rawType.includes("max_output_tokens") || message.includes("max output tokens"))
    return "max_output_tokens";
  if (rawType.includes("prompt") || message.includes("prompt too long")) return "prompt_too_long";
  return null;
};

const toThresholdLevel = (budget: {
  inWarning: boolean;
  requiresAutoCompact: boolean;
  shouldBlock: boolean;
  estimatedInputTokens: number;
  errorThreshold: number;
}): "healthy" | "warning" | "auto_compact" | "error" | "blocking" => {
  if (budget.shouldBlock) return "blocking";
  if (budget.estimatedInputTokens >= budget.errorThreshold) return "error";
  if (budget.requiresAutoCompact) return "auto_compact";
  if (budget.inWarning) return "warning";
  return "healthy";
};

type ModelRequestWithContextMetadata = ModelRequest & {
  contextMetadata?: {
    apiViewId?: string;
    compactBoundaryId?: string;
    thresholdLevel?: "healthy" | "warning" | "auto_compact" | "error" | "blocking";
  };
};

const getResponseId = (response: ModelResponse): string | undefined =>
  (response as { responseId?: string }).responseId;

const getResponseUsage = (
  response: ModelResponse,
): { inputTokens?: number; outputTokens?: number } | undefined =>
  (response as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;

const getDoneEventResponseId = (event: { type: string }): string | undefined =>
  (event as { responseId?: string }).responseId;

const getDoneEventUsage = (event: {
  type: string;
}): { inputTokens?: number; outputTokens?: number } | undefined =>
  (event as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;

const getDoneEventIteration = (event: { type: string }): Record<string, unknown> | undefined =>
  (event as { iteration?: Record<string, unknown> }).iteration;

const computeBackoffMs = (attempt: number, baseDelayMs: number, maxDelayMs: number): number =>
  Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));

const sleep = async (ms: number): Promise<void> => {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

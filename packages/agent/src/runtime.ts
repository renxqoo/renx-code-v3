import type { ModelClient, ToolDefinition } from "@renx/model";

import { AgentError } from "./errors";
import { isTerminalStatus } from "./helpers";
import { applyStatePatch } from "./state";
import type {
  AgentStatePatch,
  AgentRunContext,
  AgentResult,
  AgentState,
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
  private readonly name: string;
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
  private readonly toolExecutor: ToolExecutor;
  private readonly registry: InMemoryToolRegistry;

  /** Track first checkpoint createdAt for resume. */
  private firstCreatedAt: string | undefined;

  constructor(config: RuntimeConfig) {
    this.name = config.name;
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

    this.registry = new InMemoryToolRegistry();
    for (const tool of this.toolList) {
      this.registry.register(tool);
    }

    this.toolExecutor = new ToolExecutor(this.registry, this.pipeline, config.backendResolver);
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

      // Load memory from MemoryStore
      if (ctx.services.memory) {
        const loaded = await ctx.services.memory.load(ctx);
        ctx = { ...ctx, state: { ...ctx.state, memory: { ...ctx.state.memory, ...loaded } } };
      }

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

        // Build effective messages
        const effectiveMessages = this.messageManager.buildEffectiveMessages(ctx);

        // Filter tools via policy
        const allowedTools = await this.policy.filterTools(ctx, this.toolList);

        // Convert to ToolDefinition for the model
        const toolDefs: ToolDefinition[] = allowedTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
            type: "object",
            properties: {},
          },
        }));

        // Build model request
        let modelRequest = {
          model: this.model,
          systemPrompt: this.systemPrompt,
          messages: effectiveMessages,
          tools: toolDefs,
        };

        // Run beforeModel middleware
        modelRequest = await this.pipeline.runBeforeModel(ctx, modelRequest);

        // Call model
        this.emitAudit(ctx, {
          type: "model_called",
          payload: {
            stepCount: ctx.state.stepCount,
            messageCount: modelRequest.messages.length,
            toolCount: modelRequest.tools.length,
          },
        });

        let modelResponse = await this.modelClient.generate(modelRequest);

        this.emitAudit(ctx, {
          type: "model_returned",
          payload: { stepCount: ctx.state.stepCount, responseType: modelResponse.type },
        });

        // Run afterModel middleware
        modelResponse = await this.pipeline.runAfterModel(ctx, modelResponse);

        // Track last model response
        ctx = { ...ctx, state: { ...ctx.state, lastModelResponse: modelResponse } };

        // --- Branch: Final answer ---
        if (modelResponse.type === "final") {
          ctx = this.patchState(ctx, {}, (s) =>
            this.messageManager.appendAssistantMessage(s, modelResponse.output),
          );
          ctx = this.patchState(ctx, { setStatus: "completed" });
          break;
        }

        // --- Branch: Tool calls ---
        if (modelResponse.type === "tool_calls") {
          // Record assistant tool-call message
          ctx = this.patchState(ctx, {}, (s) =>
            this.messageManager.appendAssistantToolCallMessage(s, "", modelResponse.toolCalls),
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
                  id: crypto.randomUUID(),
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

      // Save memory
      if (ctx.services.memory?.save) {
        await ctx.services.memory.save(ctx, ctx.state.memory);
      }

      // Save final checkpoint
      await this.saveCheckpoint(ctx.state);

      const finalStatus = ctx.state.status;
      this.emitAudit(ctx, {
        type:
          isTerminalStatus(finalStatus) && finalStatus === "completed"
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

      await this.pipeline.runOnError(ctx, agentError);
      await this.saveCheckpoint(ctx.state);

      this.emitAudit(ctx, {
        type: "run_failed",
        payload: { code: agentError.code, message: agentError.message },
      });

      return {
        runId: ctx.state.runId,
        status: "failed",
        error: agentError,
        state: ctx.state,
      };
    }
  }

  // --- Helpers ---

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
      id: crypto.randomUUID(),
      runId: ctx.state.runId,
      ...event,
      timestamp: new Date().toISOString(),
    });
  }
}

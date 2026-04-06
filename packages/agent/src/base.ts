import { generateId } from "./helpers";
import type { ModelClient } from "@renx/model";

import { AgentRuntime, type RuntimeConfig } from "./runtime";
import { getResponseId, toToolInputSchema } from "./runtime/utils";
import { MiddlewarePipeline } from "./middleware/pipeline";
import type { AgentMiddleware } from "./middleware/types";
import { AllowAllPolicy } from "./policy";
import { ContextOrchestrator, initialContextRuntimeState } from "./context";
import { DefaultMessageManager } from "./message/manager";
import { TimelineManager } from "./timeline";
import { buildResumeAtPlan, type ResumeAtRuntimeOptions } from "./timeline";
import { formatCompactSummary, getCompactPrompt } from "./context/summary-prompt";
import { restoreCanonicalMessages } from "./context/api-view";
import {
  applySessionMemoryRecordToState,
  ModelSessionMemoryExtractor,
  SessionMemoryService,
} from "./context/session-memory";
import { MemoryService } from "./memory";
import type { MemorySubsystem } from "./memory";
import type {
  AgentCompactOptions,
  AgentCompactResult,
  AgentIdentity,
  AgentInput,
  AgentResumeSnapshot,
  AgentResult,
  AgentRunContext,
  AgentServices,
  AgentState,
  AgentStreamEvent,
  ContextLifecycleHooks,
  TimelineStore,
  AuditLogger,
  ApprovalEngine,
  ResumeAtOptions,
  PolicyEngine,
  SessionMemoryRecord,
  SessionMemorySubsystem,
} from "./types";
import type { AgentTool, BackendResolver } from "./tool/types";
import type { ContextManagerConfig } from "./context/types";

interface AgentRunOverrides {
  maxSteps?: number;
}

/**
 * Abstract base class for enterprise agents.
 *
 * Uses the Template Method pattern — subclasses override abstract methods
 * to declare their specific tools, prompts, policies, etc.
 * The base class handles assembly, context creation, and run lifecycle.
 *
 * Usage:
 * ```ts
 * class MyAgent extends AgentBase {
 *   protected getName() { return "my-agent"; }
 *   protected getSystemPrompt() { return "You are a helpful assistant."; }
 *   protected getTools() { return [new EchoTool()]; }
 *   protected getModelClient() { return myModelClient; }
 *   protected getModelName() { return "openrouter:qwen/qwen3.6-plus-preview:free"; }
 * }
 *
 * const agent = new MyAgent();
 * const result = await agent.invoke({
 *   messages: [
 *     {
 *       role: "user",
 *       content: "Hello!",
 *       id: "msg_1",
 *       createdAt: new Date().toISOString(),
 *       messageId: "msg_1",
 *     },
 *   ],
 * });
 * ```
 */
export abstract class AgentBase {
  // --- Abstract methods (must override) ---

  protected abstract getName(): string;
  protected abstract getSystemPrompt(ctx: AgentRunContext): string | Promise<string>;
  protected abstract getTools(ctx: AgentRunContext): AgentTool[] | Promise<AgentTool[]>;
  protected abstract getModelClient(): ModelClient;
  protected abstract getModelName(): string;

  // --- Virtual methods (optional override) ---

  protected getMiddlewares(): AgentMiddleware[] {
    return [];
  }

  protected getPolicy(): PolicyEngine {
    return new AllowAllPolicy();
  }

  protected getMaxSteps(): number {
    return 100000;
  }

  protected getTimelineStore(): TimelineStore | undefined {
    return undefined;
  }

  protected getAuditLogger(): AuditLogger | undefined {
    return undefined;
  }

  protected getApprovalEngine(): ApprovalEngine | undefined {
    return undefined;
  }

  protected getMemory(): MemorySubsystem | undefined {
    return undefined;
  }

  protected getSessionMemory(): SessionMemorySubsystem | undefined {
    return undefined;
  }

  protected getBackendResolver(): BackendResolver | undefined {
    return undefined;
  }

  protected getContextConfig(): Partial<ContextManagerConfig> | undefined {
    return undefined;
  }

  protected getRetryConfig(): RuntimeConfig["retry"] | undefined {
    return undefined;
  }

  protected getContextLifecycleHooks(): ContextLifecycleHooks | undefined {
    return undefined;
  }

  protected getIdentity(): AgentIdentity {
    return {
      userId: "unknown",
      tenantId: "default",
      roles: [],
    };
  }

  // --- Public API ---

  /**
   * Invoke the agent with the given input.
   */
  async invoke(input: AgentInput, overrides?: AgentRunOverrides): Promise<AgentResult> {
    const ctx = await this.createRunContext(input);
    const runtime = await this.createRuntime(ctx, overrides);
    return runtime.run(ctx);
  }

  /**
   * Stream the agent execution, yielding lifecycle events as they occur.
   * Returns the final AgentResult after all events have been yielded.
   */
  async *stream(
    input: AgentInput,
    overrides?: AgentRunOverrides,
  ): AsyncGenerator<AgentStreamEvent, AgentResult> {
    const ctx = await this.createRunContext(input);
    const runtime = await this.createRuntime(ctx, overrides);
    return yield* runtime.stream(ctx);
  }

  /**
   * Resume a previously interrupted run from its latest timeline snapshot.
   */
  async resume(runId: string): Promise<AgentResult> {
    const snapshot = await this.loadResumeSnapshot(runId);
    const ctx = this.createContextFromResumeSnapshot(snapshot);
    const runtime = await this.createRuntime(ctx);
    return runtime.run(ctx);
  }

  /**
   * Resume from an arbitrary historical timeline node.
   */
  async resumeAt(runId: string, nodeId: string, options?: ResumeAtOptions): Promise<AgentResult> {
    const timeline = this.getTimelineStore();
    if (!timeline) {
      throw new Error("TimelineStore is required for resumeAt");
    }

    const snapshot = await this.loadResumeSnapshotAt(runId, nodeId);
    const ctx = this.createContextFromResumeSnapshot(snapshot);
    const plan = await buildResumeAtPlan({
      timeline,
      runId,
      targetNodeId: nodeId,
      basePolicy: this.getPolicy(),
      ...(options ? { options } : {}),
    });
    const runtimeOverrides = this.toRuntimeOverrideConfig(plan.runtime);
    const runtime = await this.createRuntime(ctx, runtimeOverrides);
    return runtime.run(ctx);
  }

  async loadResumeSnapshot(runId: string): Promise<AgentResumeSnapshot> {
    return await this.loadResumeSnapshotInternal(runId);
  }

  async loadResumeSnapshotAt(runId: string, nodeId: string): Promise<AgentResumeSnapshot> {
    return await this.loadResumeSnapshotInternal(runId, nodeId);
  }

  async loadMemorySnapshot(runId: string) {
    return await new MemoryService(this.getMemory()).loadSnapshot(runId);
  }

  /**
   * Compact the latest timeline snapshot without executing another model turn.
   */
  async compact(runId: string, options?: AgentCompactOptions): Promise<AgentCompactResult> {
    const timeline = this.getTimelineStore();
    if (!timeline) {
      throw new Error("TimelineStore is required for compact");
    }

    const record = await timeline.load(runId);
    if (!record) {
      throw new Error(`Timeline snapshot not found: ${runId}`);
    }

    const ctx = await this.createCompactionContext(record);
    const messageManager = new DefaultMessageManager();
    const tools = await this.getTools(ctx);
    const lifecycleHooks = this.getContextLifecycleHooks();
    await lifecycleHooks?.beforeCompact?.({
      runId,
      source: "manual",
      reason: options?.customInstructions ? "manual_compact_custom_instructions" : "manual_compact",
    });
    const prepared = new ContextOrchestrator(this.getContextConfig()).compact({
      systemPrompt: await this.getSystemPrompt(ctx),
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: toToolInputSchema(tool),
      })),
      apiView: messageManager.buildEffectiveMessages(ctx),
      canonicalMessages: ctx.state.messages,
      memory: ctx.state.memory,
      ...(ctx.state.context ? { contextState: ctx.state.context } : {}),
      ...(options?.customInstructions ? { customInstructions: options.customInstructions } : {}),
    });

    let nextState: AgentState = {
      ...record.state,
      messages: prepared.canonicalMessages ?? record.state.messages,
      context: prepared.nextState,
    };
    nextState = await this.refineCompactSummaryIfNeeded(nextState, options?.customInstructions);
    await new TimelineManager(timeline).save(runId, nextState);
    const diagnostics = nextState.context?.compactionDiagnostics ?? [];
    const latestDiagnostic = diagnostics[diagnostics.length - 1];
    if (latestDiagnostic?.source === "manual") {
      await lifecycleHooks?.afterCompact?.({
        runId,
        diagnostic: latestDiagnostic,
      });
    }

    return {
      runId,
      compacted:
        nextState.messages !== record.state.messages ||
        prepared.nextState.compactBoundaries.length >
          (record.state.context?.compactBoundaries.length ?? 0),
      state: nextState,
    };
  }

  async extractSessionMemory(runId: string): Promise<SessionMemoryRecord> {
    const timeline = this.getTimelineStore();
    if (!timeline) {
      throw new Error("TimelineStore is required for extractSessionMemory");
    }
    const sessionMemory = this.getSessionMemory();
    if (!sessionMemory) {
      throw new Error("Session memory is not configured");
    }

    const record = await timeline.load(runId);
    if (!record) {
      throw new Error(`Timeline snapshot not found: ${runId}`);
    }

    const service = this.createSessionMemoryService(sessionMemory);
    const hydratedState = await service.hydrateState(runId, record.state, {
      waitForPendingExtraction: true,
    });
    const currentRecord =
      (await sessionMemory.store.load(runId)) ?? (await service.ensureRecord(runId));
    const extracted = await service.extractNow({
      runId,
      messages: hydratedState.messages,
      record: currentRecord,
    });
    const nextState = applySessionMemoryRecordToState(hydratedState, extracted);
    await new TimelineManager(timeline).save(runId, nextState);
    return extracted;
  }

  // --- Protected helpers ---

  protected async createRunContext(input: AgentInput): Promise<AgentRunContext> {
    const runId = generateId("run");

    const identity = this.getIdentity();
    const state: AgentState = {
      runId,
      // Keep canonical state empty at boot.
      // Incoming messages are normalized and appended in runtime initialization.
      messages: [],
      scratchpad: {},
      memory: {},
      context: initialContextRuntimeState(),
      stepCount: 0,
      status: "running",
    };

    const services = this.buildServices();

    return {
      input,
      identity,
      state,
      services,
      metadata: input.metadata ?? {},
    };
  }

  protected async createResumeContext(record: {
    runId: string;
    state: AgentState;
  }): Promise<AgentRunContext> {
    const hydratedState = await this.hydrateStateWithSessionMemory(
      record.runId,
      record.state,
      true,
    );
    return {
      input: {},
      identity: this.getIdentity(),
      state: {
        ...hydratedState,
        messages: restoreCanonicalMessages(
          hydratedState.messages,
          hydratedState.context ?? initialContextRuntimeState(),
        ),
        context: hydratedState.context ?? initialContextRuntimeState(),
        status: "running",
      },
      services: this.buildServices(),
      metadata: {},
    };
  }

  protected async createCompactionContext(record: {
    runId: string;
    state: AgentState;
  }): Promise<AgentRunContext> {
    const hydratedState = await this.hydrateStateWithSessionMemory(
      record.runId,
      record.state,
      true,
    );
    return {
      input: {},
      identity: this.getIdentity(),
      state: {
        ...hydratedState,
        context: hydratedState.context ?? initialContextRuntimeState(),
      },
      services: this.buildServices(),
      metadata: {},
    };
  }

  private buildServices(): AgentServices {
    const services: AgentServices = {};
    const timeline = this.getTimelineStore();
    if (timeline) services.timeline = timeline;
    const audit = this.getAuditLogger();
    if (audit) services.audit = audit;
    const approvalEngine = this.getApprovalEngine();
    if (approvalEngine) services.approvalEngine = approvalEngine;
    const memory = this.getMemory();
    if (memory) services.memory = memory;
    const sessionMemory = memory?.session ?? this.getSessionMemory();
    if (sessionMemory) services.sessionMemory = sessionMemory;
    return services;
  }

  protected async createRuntime(
    ctx: AgentRunContext,
    overrides?: ResumeAtRuntimeOptions & AgentRunOverrides,
  ): Promise<AgentRuntime> {
    const middlewares = this.getMiddlewares();

    const pipeline = new MiddlewarePipeline(middlewares);

    const hasTimelineOverride =
      overrides !== undefined && Object.prototype.hasOwnProperty.call(overrides, "timeline");
    const timeline = overrides?.disableTimeline
      ? undefined
      : hasTimelineOverride
        ? overrides.timeline
        : this.getTimelineStore();
    const audit = this.getAuditLogger();
    const backendResolver = this.getBackendResolver();
    const context = this.getContextConfig();
    const retry = this.getRetryConfig();
    const lifecycleHooks = this.getContextLifecycleHooks();
    const config: RuntimeConfig = {
      name: this.getName(),
      modelClient: this.getModelClient(),
      model: this.getModelName(),
      tools: await this.getTools(ctx),
      pipeline,
      policy: overrides?.policy ?? this.getPolicy(),
      ...(timeline ? { timeline } : {}),
      ...(ctx.services.memory ? { memory: ctx.services.memory } : {}),
      ...(ctx.services.sessionMemory ? { sessionMemory: ctx.services.sessionMemory } : {}),
      ...(lifecycleHooks ? { contextLifecycleHooks: lifecycleHooks } : {}),
      ...(overrides?.timelineMode ? { timelineMode: overrides.timelineMode } : {}),
      ...(overrides?.timelineParentNodeId
        ? { timelineParentNodeId: overrides.timelineParentNodeId }
        : {}),
      ...(audit ? { audit } : {}),
      systemPrompt: await this.getSystemPrompt(ctx),
      maxSteps: overrides?.maxSteps ?? this.getMaxSteps(),
      ...(backendResolver ? { backendResolver } : {}),
      ...(context ? { context } : {}),
      ...(retry ? { retry } : {}),
    };

    return new AgentRuntime(config);
  }

  private async hydrateStateWithSessionMemory(
    runId: string,
    state: AgentState,
    waitForPendingExtraction: boolean,
  ): Promise<AgentState> {
    let hydratedState = await new MemoryService(this.getMemory()).hydrateState(runId, state, {
      runId,
      ...(this.getIdentity().userId ? { userId: this.getIdentity().userId } : {}),
      ...(this.getIdentity().tenantId ? { tenantId: this.getIdentity().tenantId } : {}),
    });
    const sessionMemory = this.getSessionMemory();
    if (!sessionMemory) return hydratedState;
    const service = this.createSessionMemoryService(sessionMemory);
    hydratedState = await service.hydrateState(runId, hydratedState, {
      waitForPendingExtraction,
    });
    return hydratedState;
  }

  private createSessionMemoryService(sessionMemory: SessionMemorySubsystem): SessionMemoryService {
    return new SessionMemoryService(
      sessionMemory,
      new ModelSessionMemoryExtractor(this.getModelClient(), this.getModelName()),
    );
  }

  private toRuntimeOverrideConfig(overrides: ResumeAtRuntimeOptions): ResumeAtRuntimeOptions {
    return {
      ...(overrides.timeline ? { timeline: overrides.timeline } : {}),
      ...(overrides.policy ? { policy: overrides.policy } : {}),
      ...(overrides.timelineMode ? { timelineMode: overrides.timelineMode } : {}),
      ...(overrides.timelineParentNodeId
        ? { timelineParentNodeId: overrides.timelineParentNodeId }
        : {}),
      ...(overrides.disableTimeline ? { disableTimeline: true } : {}),
    };
  }

  private async refineCompactSummaryIfNeeded(
    state: AgentState,
    customInstructions?: string,
  ): Promise<AgentState> {
    const boundaryMessage = state.messages.find((message) => message.compactBoundary);
    if (boundaryMessage?.compactBoundary?.strategy === "session_memory") {
      return state;
    }
    const summaryIndex = state.messages.findIndex((message) => message.id.startsWith("summary_"));
    if (summaryIndex < 0) return state;
    const summaryMessage = state.messages[summaryIndex];
    if (!summaryMessage) return state;
    if (summaryMessage.metadata?.["compactRefined"] === true) return state;
    const context = state.context ?? initialContextRuntimeState();
    let summaryInput = summaryMessage.content;
    const compactSource = summaryMessage.metadata?.["compactSource"];
    if (typeof compactSource === "string" && compactSource.trim().length > 0) {
      summaryInput = compactSource;
    }
    let compactResponse:
      | Extract<Awaited<ReturnType<ModelClient["generate"]>>, { type: "final" }>
      | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.getModelClient().generate({
          model: this.getModelName(),
          systemPrompt: "You are a helpful AI assistant tasked with summarizing conversations.",
          messages: [
            {
              id: `compact_req_${Date.now()}`,
              role: "user",
              content: `${getCompactPrompt(customInstructions)}\n\nConversation to summarize:\n${summaryInput}`,
              createdAt: new Date().toISOString(),
            },
          ],
          tools: [],
          metadata: {
            compactRefine: true,
            ...(context.forkedCachePrefix ? { compactCachePrefix: context.forkedCachePrefix } : {}),
          },
          maxTokens: 1_500,
        });
        if (response.type !== "final") return state;
        compactResponse = response;
        break;
      } catch (error) {
        if (!isPromptTooLongError(error) || attempt >= 2) throw error;
        summaryInput = shrinkSummaryInput(summaryInput);
      }
    }
    if (!compactResponse) return state;

    const formattedSummary = formatCompactSummary(compactResponse.output);
    const nextMessages = [...state.messages];
    nextMessages[summaryIndex] = {
      ...summaryMessage,
      content: formattedSummary,
      metadata: {
        ...summaryMessage.metadata,
        compactRefined: true,
      },
    };
    const compactResponseId = getResponseId(compactResponse);
    const segmentId = summaryMessage.preservedSegmentRef?.segmentId;
    const nextContext = {
      ...context,
      ...(segmentId
        ? {
            preservedSegments: {
              ...context.preservedSegments,
              [segmentId]: {
                ...(context.preservedSegments[segmentId] ?? {
                  digest: summaryMessage.preservedSegmentRef?.digest ?? "",
                  messageIds: [],
                  createdAt: new Date().toISOString(),
                }),
                summary: formattedSummary,
              },
            },
          }
        : {}),
      ...(compactResponseId ? { lastSummaryResponseId: compactResponseId } : {}),
      ...(compactResponseId ? { forkedCachePrefix: compactResponseId } : {}),
    };

    return {
      ...state,
      messages: nextMessages,
      context: nextContext,
    };
  }

  private async loadResumeSnapshotInternal(
    runId: string,
    nodeId?: string,
  ): Promise<AgentResumeSnapshot> {
    const timeline = this.getTimelineStore();
    if (!timeline) {
      throw new Error(
        nodeId ? "TimelineStore is required for resumeAt" : "TimelineStore is required for resume",
      );
    }
    const lifecycleHooks = this.getContextLifecycleHooks();
    const record = nodeId ? await timeline.loadNode(runId, nodeId) : await timeline.load(runId);
    if (!record) {
      throw new Error(
        nodeId
          ? `Timeline node not found: ${runId}/${nodeId}`
          : `Timeline snapshot not found: ${runId}`,
      );
    }
    await lifecycleHooks?.beforeResume?.({
      runId,
      nodeId: record.nodeId,
      mode: nodeId ? "node" : "head",
    });
    const ctx = await this.createResumeContext(record);
    const apiView = new DefaultMessageManager().buildEffectiveMessages(ctx);
    const snapshot: AgentResumeSnapshot = {
      runId,
      nodeId: record.nodeId,
      mode: nodeId ? "node" : "head",
      state: ctx.state,
      apiView,
      ...(ctx.state.context?.lastEffectiveRequestSnapshot
        ? { effectiveRequest: ctx.state.context.lastEffectiveRequestSnapshot }
        : {}),
      diagnostics: ctx.state.context?.compactionDiagnostics ?? [],
      createdAt: new Date().toISOString(),
    };
    await lifecycleHooks?.afterResume?.(snapshot);
    return snapshot;
  }

  private createContextFromResumeSnapshot(snapshot: AgentResumeSnapshot): AgentRunContext {
    return {
      input: {},
      identity: this.getIdentity(),
      state: {
        ...snapshot.state,
        status: "running",
      },
      services: this.buildServices(),
      metadata: {},
    };
  }
}

const isPromptTooLongError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { code?: unknown; rawType?: unknown; message?: unknown };
  const rawType = typeof maybe.rawType === "string" ? maybe.rawType.toLowerCase() : "";
  const message = typeof maybe.message === "string" ? maybe.message.toLowerCase() : "";
  return (
    maybe.code === "INVALID_REQUEST" &&
    (rawType.includes("prompt") ||
      rawType.includes("context") ||
      message.includes("prompt too long") ||
      message.includes("input is too long") ||
      message.includes("too many tokens"))
  );
};

const shrinkSummaryInput = (input: string): string => {
  if (input.length <= 400) return input.slice(0, Math.max(120, Math.floor(input.length * 0.7)));
  return input.slice(Math.floor(input.length * 0.3));
};

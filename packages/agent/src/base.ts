import { generateId } from "./helpers";
import type { ModelClient } from "@renx/model";

import { AgentRuntime, type RuntimeConfig } from "./runtime";
import { MiddlewarePipeline } from "./middleware/pipeline";
import { AgentMemoryMiddleware } from "./middleware/agent-memory";
import type { AgentMiddleware } from "./middleware/types";
import { AllowAllPolicy } from "./policy";
import { initialContextRuntimeState } from "./context";
import { buildResumeAtPlan, type ResumeAtRuntimeOptions } from "./timeline";
import type {
  AgentIdentity,
  AgentInput,
  AgentResult,
  AgentRunContext,
  AgentServices,
  AgentState,
  AgentStreamEvent,
  TimelineStore,
  AuditLogger,
  ApprovalEngine,
  ResumeAtOptions,
  Store,
  PolicyEngine,
} from "./types";
import type { AgentTool, BackendResolver } from "./tool/types";
import type { ContextManagerConfig } from "./context/types";

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
 * const result = await agent.invoke({ inputText: "Hello!" });
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
    return 12;
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

  protected getMemoryStore(): Store | undefined {
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
  async invoke(input: AgentInput): Promise<AgentResult> {
    const ctx = await this.createRunContext(input);
    const runtime = await this.createRuntime(ctx);
    return runtime.run(ctx);
  }

  /**
   * Stream the agent execution, yielding lifecycle events as they occur.
   * Returns the final AgentResult after all events have been yielded.
   */
  async *stream(input: AgentInput): AsyncGenerator<AgentStreamEvent, AgentResult> {
    const ctx = await this.createRunContext(input);
    const runtime = await this.createRuntime(ctx);
    return yield* runtime.stream(ctx);
  }

  /**
   * Resume a previously interrupted run from its latest timeline snapshot.
   */
  async resume(runId: string): Promise<AgentResult> {
    const timeline = this.getTimelineStore();
    if (!timeline) {
      throw new Error("TimelineStore is required for resume");
    }

    const record = await timeline.load(runId);
    if (!record) {
      throw new Error(`Timeline snapshot not found: ${runId}`);
    }

    const ctx = await this.createResumeContext(record);
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

    const node = await timeline.loadNode(runId, nodeId);
    if (!node) {
      throw new Error(`Timeline node not found: ${runId}/${nodeId}`);
    }

    const ctx = await this.createResumeContext(node);
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

  // --- Protected helpers ---

  protected async createRunContext(input: AgentInput): Promise<AgentRunContext> {
    const runId = generateId("run");

    const identity = this.getIdentity();
    const state: AgentState = {
      runId,
      messages: input.messages ?? [],
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
    return {
      input: {},
      identity: this.getIdentity(),
      state: {
        ...record.state,
        context: record.state.context ?? initialContextRuntimeState(),
        status: "running",
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
    return services;
  }

  protected async createRuntime(
    ctx: AgentRunContext,
    overrides?: ResumeAtRuntimeOptions,
  ): Promise<AgentRuntime> {
    const middlewares = this.getMiddlewares();

    // Auto-register memory middleware
    const memoryStore = this.getMemoryStore();
    if (memoryStore) {
      middlewares.push(new AgentMemoryMiddleware(memoryStore));
    }

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

    const config: RuntimeConfig = {
      name: this.getName(),
      modelClient: this.getModelClient(),
      model: this.getModelName(),
      tools: await this.getTools(ctx),
      pipeline,
      policy: overrides?.policy ?? this.getPolicy(),
      ...(timeline ? { timeline } : {}),
      ...(overrides?.timelineMode ? { timelineMode: overrides.timelineMode } : {}),
      ...(overrides?.timelineParentNodeId
        ? { timelineParentNodeId: overrides.timelineParentNodeId }
        : {}),
      ...(audit ? { audit } : {}),
      systemPrompt: await this.getSystemPrompt(ctx),
      maxSteps: this.getMaxSteps(),
      ...(backendResolver ? { backendResolver } : {}),
      ...(context ? { context } : {}),
      ...(retry ? { retry } : {}),
    };

    return new AgentRuntime(config);
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
}

import type { ModelClient } from "@renx/model";

import { AgentRuntime, type RuntimeConfig } from "./runtime";
import { MiddlewarePipeline } from "./middleware/pipeline";
import type { AgentMiddleware } from "./middleware/types";
import { AllowAllPolicy } from "./policy";
import type {
  AgentIdentity,
  AgentInput,
  AgentResult,
  AgentRunContext,
  AgentServices,
  AgentState,
  CheckpointStore,
  AuditLogger,
  ApprovalService,
  MemoryStore,
  PolicyEngine,
} from "./types";
import type { AgentTool, BackendResolver } from "./tool/types";

/**
 * Abstract base class for enterprise agents.
 *
 * Uses the Template Method pattern — subclasses override abstract methods
 * to declare their specific tools, prompts, policies, etc.
 * The base class handles assembly, context creation, and run lifecycle.
 *
 * Usage:
 * ```ts
 * class MyAgent extends EnterpriseAgentBase {
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
export abstract class EnterpriseAgentBase {
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

  protected getCheckpointStore(): CheckpointStore | undefined {
    return undefined;
  }

  protected getAuditLogger(): AuditLogger | undefined {
    return undefined;
  }

  protected getApprovalService(): ApprovalService | undefined {
    return undefined;
  }

  protected getMemoryStore(): MemoryStore | undefined {
    return undefined;
  }

  protected getBackendResolver(): BackendResolver | undefined {
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
   * Resume a previously interrupted run from its checkpoint.
   */
  async resume(runId: string, payload?: Record<string, unknown>): Promise<AgentResult> {
    const checkpoint = this.getCheckpointStore();
    if (!checkpoint) {
      throw new Error("CheckpointStore is required for resume");
    }

    const record = await checkpoint.load(runId);
    if (!record) {
      throw new Error(`Checkpoint not found: ${runId}`);
    }

    const ctx = await this.createResumeContext(record, payload);
    const runtime = await this.createRuntime(ctx);
    return runtime.run(ctx);
  }

  // --- Protected helpers ---

  protected async createRunContext(input: AgentInput): Promise<AgentRunContext> {
    const runId = crypto.randomUUID();

    const identity = this.getIdentity();
    const state: AgentState = {
      runId,
      messages: input.messages ?? [],
      scratchpad: {},
      memory: {},
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

  protected async createResumeContext(
    record: { runId: string; state: AgentState },
    payload?: Record<string, unknown>,
  ): Promise<AgentRunContext> {
    const input: AgentInput = {};
    if (payload) input.metadata = payload;

    return {
      input,
      identity: this.getIdentity(),
      state: {
        ...record.state,
        status: "running",
      },
      services: this.buildServices(),
      metadata: payload ?? {},
    };
  }

  private buildServices(): AgentServices {
    const services: AgentServices = {};
    const checkpoint = this.getCheckpointStore();
    if (checkpoint) services.checkpoint = checkpoint;
    const audit = this.getAuditLogger();
    if (audit) services.audit = audit;
    const approval = this.getApprovalService();
    if (approval) services.approval = approval;
    const memory = this.getMemoryStore();
    if (memory) services.memory = memory;
    return services;
  }

  protected async createRuntime(ctx: AgentRunContext): Promise<AgentRuntime> {
    const pipeline = new MiddlewarePipeline(this.getMiddlewares());

    const checkpoint = this.getCheckpointStore();
    const audit = this.getAuditLogger();
    const backendResolver = this.getBackendResolver();

    const config: RuntimeConfig = {
      name: this.getName(),
      modelClient: this.getModelClient(),
      model: this.getModelName(),
      tools: await this.getTools(ctx),
      pipeline,
      policy: this.getPolicy(),
      ...(checkpoint ? { checkpoint } : {}),
      ...(audit ? { audit } : {}),
      systemPrompt: await this.getSystemPrompt(ctx),
      maxSteps: this.getMaxSteps(),
      ...(backendResolver ? { backendResolver } : {}),
    };

    return new AgentRuntime(config);
  }
}

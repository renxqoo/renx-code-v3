import type { ModelClient } from "@renx/model";
import { AgentRuntime } from "./runtime";
import type { AgentMiddleware } from "./middleware/types";
import type { AgentIdentity, AgentInput, AgentResult, AgentRunContext, AgentState, CheckpointStore, AuditLogger, ApprovalService, MemoryStore, PolicyEngine } from "./types";
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
export declare abstract class EnterpriseAgentBase {
    protected abstract getName(): string;
    protected abstract getSystemPrompt(ctx: AgentRunContext): string | Promise<string>;
    protected abstract getTools(ctx: AgentRunContext): AgentTool[] | Promise<AgentTool[]>;
    protected abstract getModelClient(): ModelClient;
    protected abstract getModelName(): string;
    protected getMiddlewares(): AgentMiddleware[];
    protected getPolicy(): PolicyEngine;
    protected getMaxSteps(): number;
    protected getCheckpointStore(): CheckpointStore | undefined;
    protected getAuditLogger(): AuditLogger | undefined;
    protected getApprovalService(): ApprovalService | undefined;
    protected getMemoryStore(): MemoryStore | undefined;
    protected getBackendResolver(): BackendResolver | undefined;
    protected getIdentity(): AgentIdentity;
    /**
     * Invoke the agent with the given input.
     */
    invoke(input: AgentInput): Promise<AgentResult>;
    /**
     * Resume a previously interrupted run from its checkpoint.
     */
    resume(runId: string, payload?: Record<string, unknown>): Promise<AgentResult>;
    protected createRunContext(input: AgentInput): Promise<AgentRunContext>;
    protected createResumeContext(record: {
        runId: string;
        state: AgentState;
    }, payload?: Record<string, unknown>): Promise<AgentRunContext>;
    private buildServices;
    protected createRuntime(ctx: AgentRunContext): Promise<AgentRuntime>;
}
//# sourceMappingURL=base.d.ts.map
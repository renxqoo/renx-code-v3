import type { ModelClient } from "@renx/model";
import type { AgentRunContext, AgentResult, AuditLogger, CheckpointStore, PolicyEngine } from "./types";
import { DefaultMessageManager } from "./message/manager";
import { MiddlewarePipeline } from "./middleware/pipeline";
import type { AgentTool, BackendResolver } from "./tool/types";
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
export declare class AgentRuntime {
    private readonly name;
    private readonly modelClient;
    private readonly model;
    private readonly toolList;
    private readonly pipeline;
    private readonly messageManager;
    private readonly policy;
    private readonly checkpoint;
    private readonly audit;
    private readonly systemPrompt;
    private readonly maxSteps;
    private readonly toolExecutor;
    private readonly registry;
    /** Track first checkpoint createdAt for resume. */
    private firstCreatedAt;
    constructor(config: RuntimeConfig);
    run(ctx: AgentRunContext): Promise<AgentResult>;
    private patchState;
    private saveCheckpoint;
    private emitAudit;
}
//# sourceMappingURL=runtime.d.ts.map
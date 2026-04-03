import type { ModelClient } from "@renx/model";

import type { DefaultMessageManager } from "../message/manager";
import type { MiddlewarePipeline } from "../middleware/pipeline";
import type { PolicyEngine, ResumeAtMode, TimelineStore, AuditLogger } from "../types";
import type { AgentTool, BackendResolver } from "../tool/types";
import type { ContextManagerConfig } from "../context/types";

export interface RuntimeConfig {
  name: string;
  modelClient: ModelClient;
  model: string;
  tools: AgentTool[];
  pipeline?: MiddlewarePipeline;
  messageManager?: DefaultMessageManager;
  policy?: PolicyEngine;
  timeline?: TimelineStore;
  timelineMode?: ResumeAtMode;
  timelineParentNodeId?: string;
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

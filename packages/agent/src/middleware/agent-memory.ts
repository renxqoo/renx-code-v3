import type { ModelRequest } from "@renx/model";

import { generateId } from "../helpers";
import type { AgentError } from "../errors";
import type { AgentResult, AgentRunContext, Store } from "../types";
import type { AgentMiddleware, MiddlewareDecision } from "./types";
import type { RunMessage } from "../message/types";
import type { ToolExecutionResult } from "../tool/types";

export interface AgentMemoryOptions {
  /** How to inject memory into the model request. Default: "system". */
  injectAs?: "system" | "user";
}

/**
 * Self-contained middleware that handles memory load, inject, and save.
 *
 * Lifecycle:
 * - beforeModel: lazy-loads memory from Store (once) and injects into request
 * - afterTool:   incremental save
 * - onError:     save on error (data-loss prevention)
 * - afterRun:    final save
 */
export class AgentMemoryMiddleware implements AgentMiddleware {
  readonly name = "agent-memory";

  private readonly store: Store;
  private readonly options: AgentMemoryOptions;
  private loaded = false;

  constructor(store: Store, options?: AgentMemoryOptions) {
    this.store = store;
    this.options = options ?? {};
  }

  async beforeModel(ctx: AgentRunContext, req: ModelRequest): Promise<ModelRequest> {
    // Lazy load on first call
    if (!this.loaded) {
      this.loaded = true;
      const loaded = await this.store.load(ctx);
      ctx.state.memory = { ...ctx.state.memory, ...loaded };
    }

    // Inject when memory is non-empty
    const memory = ctx.state.memory;
    if (memory && Object.keys(memory).length > 0) {
      const content = `<user_memory>\n${JSON.stringify(memory)}\n</user_memory>`;

      if (this.options.injectAs === "user") {
        const msg: RunMessage = {
          id: generateId(),
          messageId: generateId("msg"),
          role: "user",
          content,
          createdAt: new Date().toISOString(),
          source: "memory",
        };
        return { ...req, messages: [...req.messages, msg] };
      }

      return { ...req, systemPrompt: `${req.systemPrompt}\n${content}` };
    }

    return req;
  }

  async afterTool(
    ctx: AgentRunContext,
    _result: ToolExecutionResult,
  ): Promise<MiddlewareDecision | void> {
    await this.saveMemory(ctx);
  }

  async onError(ctx: AgentRunContext, _error: AgentError): Promise<void> {
    await this.saveMemory(ctx);
  }

  async afterRun(ctx: AgentRunContext, _result: AgentResult): Promise<void> {
    await this.saveMemory(ctx);
  }

  private async saveMemory(ctx: AgentRunContext): Promise<void> {
    if (this.store.save) {
      await this.store.save(ctx, ctx.state.memory);
    }
  }
}

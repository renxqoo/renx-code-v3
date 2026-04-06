import type { AgentRunContext } from "../types";
import type { EffectiveRequestSnapshot } from "../context/types";

export interface ReplaySnapshot {
  runId: string;
  capturedAt: string;
  state: AgentRunContext["state"];
  effectiveRequest: EffectiveRequestSnapshot;
}

export class ReplayHarness {
  capture(ctx: AgentRunContext, effectiveRequest: EffectiveRequestSnapshot): ReplaySnapshot {
    return {
      runId: ctx.state.runId,
      capturedAt: new Date().toISOString(),
      state: ctx.state,
      effectiveRequest,
    };
  }
}

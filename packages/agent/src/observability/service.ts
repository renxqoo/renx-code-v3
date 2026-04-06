import type { AuditEvent, AgentRunContext } from "../types";
import { inspectMemoryHealth, type InspectMemoryHealthOptions } from "../memory";

export interface ObservabilitySink {
  record(event: AuditEvent): Promise<void>;
  list(runId: string): Promise<AuditEvent[]>;
}

export class InMemoryObservabilitySink implements ObservabilitySink {
  private readonly events = new Map<string, AuditEvent[]>();

  async record(event: AuditEvent): Promise<void> {
    const current = this.events.get(event.runId) ?? [];
    current.push(event);
    this.events.set(event.runId, current);
  }

  async list(runId: string): Promise<AuditEvent[]> {
    return [...(this.events.get(runId) ?? [])];
  }
}

export class ObservabilityService {
  constructor(private readonly sink: ObservabilitySink) {}

  async record(event: AuditEvent): Promise<void> {
    await this.sink.record(event);
  }

  async inspectRun(
    ctx: AgentRunContext,
    options?: InspectMemoryHealthOptions,
  ): Promise<{
    counts: Record<string, number>;
    memory: ReturnType<typeof inspectMemoryHealth>;
    context: {
      estimatedInputTokens: number;
      requiresAutoCompact: boolean;
      shouldBlock: boolean;
    };
    events: AuditEvent[];
  }> {
    const events = await this.sink.list(ctx.state.runId);
    const counts = events.reduce<Record<string, number>>((acc, event) => {
      acc[event.type] = (acc[event.type] ?? 0) + 1;
      return acc;
    }, {});
    const budget = ctx.state.context?.lastBudget;

    return {
      counts,
      memory: inspectMemoryHealth(ctx.state.memory, options),
      context: {
        estimatedInputTokens: budget?.estimatedInputTokens ?? 0,
        requiresAutoCompact: budget?.requiresAutoCompact ?? false,
        shouldBlock: budget?.shouldBlock ?? false,
      },
      events,
    };
  }
}

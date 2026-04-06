import { LocalBackend } from "@renx/agent";
import type { AgentRunContext, AgentTool, BackendResolver, ExecutionBackend } from "@renx/agent";
import type { ToolCall } from "@renx/model";

import type {
  ManagedSandboxBackendResolverOptions,
  ManagedSandboxLeaseRecord,
  SandboxLease,
  SandboxProvisionRequest,
} from "./types";

const toolRequiresSandboxBackend = (tool: AgentTool): boolean => {
  const capabilitySet = new Set(tool.capabilities ?? []);
  if (capabilitySet.has("requires-exec") || capabilitySet.has("exec")) {
    return true;
  }
  if (
    capabilitySet.has("requires-filesystem-read") ||
    capabilitySet.has("requires-filesystem-write")
  ) {
    return true;
  }

  const capabilityTags = new Set(tool.profile?.capabilityTags ?? []);
  return (
    capabilityTags.has("process_exec") ||
    capabilityTags.has("filesystem_read") ||
    capabilityTags.has("filesystem_write")
  );
};

export class ManagedSandboxBackendResolver implements BackendResolver {
  private readonly localBackend: ExecutionBackend;
  private readonly leasedRuns = new Map<string, Promise<SandboxLease>>();

  constructor(private readonly options: ManagedSandboxBackendResolverOptions) {
    this.localBackend = options.localBackend ?? new LocalBackend();
  }

  async resolve(
    ctx: AgentRunContext,
    tool: AgentTool,
    call: ToolCall,
  ): Promise<ExecutionBackend | undefined> {
    const shouldUseSandbox = this.options.shouldUseSandbox
      ? this.options.shouldUseSandbox(ctx, tool, call)
      : toolRequiresSandboxBackend(tool);
    if (!shouldUseSandbox) {
      return this.localBackend;
    }

    const lease = await this.getLease(ctx, tool, call);
    return this.options.factory.createBackend(lease);
  }

  async releaseRun(runId: string): Promise<void> {
    const pendingLease = this.leasedRuns.get(runId);
    this.leasedRuns.delete(runId);

    const lease = pendingLease ? await pendingLease : await this.loadPersistedLease(runId);
    if (!lease) return;

    try {
      await this.options.factory.release(lease);
    } finally {
      await this.options.leaseStore?.delete(runId);
    }
  }

  private async getLease(
    ctx: AgentRunContext,
    tool: AgentTool,
    call: ToolCall,
  ): Promise<SandboxLease> {
    const existing = this.leasedRuns.get(ctx.state.runId);
    if (existing) {
      return await existing;
    }

    const persisted = await this.loadPersistedLease(ctx.state.runId);
    if (persisted) {
      const ready = Promise.resolve(persisted);
      this.leasedRuns.set(ctx.state.runId, ready);
      await this.persistLeaseRecord(ctx.state.runId, persisted);
      return persisted;
    }

    const created = this.provisionLease(ctx, tool, call);
    this.leasedRuns.set(ctx.state.runId, created);

    try {
      return await created;
    } catch (error) {
      if (this.leasedRuns.get(ctx.state.runId) === created) {
        this.leasedRuns.delete(ctx.state.runId);
      }
      throw error;
    }
  }

  private async provisionLease(
    ctx: AgentRunContext,
    tool: AgentTool,
    call: ToolCall,
  ): Promise<SandboxLease> {
    const request =
      (await this.options.buildRequest?.(ctx, tool, call)) ??
      ({} as Omit<SandboxProvisionRequest, "provider">);
    const lease = await this.options.factory.provision({
      provider: this.options.provider,
      leaseId: request.leaseId ?? `lease_${ctx.state.runId}`,
      ...request,
    });
    await this.persistLeaseRecord(ctx.state.runId, lease);
    return lease;
  }

  private async loadPersistedLease(runId: string): Promise<SandboxLease | undefined> {
    const record = await this.options.leaseStore?.load(runId);
    if (!record || record.provider !== this.options.provider) {
      return undefined;
    }
    return record.lease;
  }

  private async persistLeaseRecord(runId: string, lease: SandboxLease): Promise<void> {
    if (!this.options.leaseStore) return;

    const existing = await this.options.leaseStore.load(runId);
    const now = new Date().toISOString();
    const record: ManagedSandboxLeaseRecord = {
      runId,
      provider: this.options.provider,
      lease,
      createdAt: existing?.createdAt ?? lease.createdAt ?? now,
      lastUsedAt: now,
    };
    await this.options.leaseStore.save(record);
  }
}

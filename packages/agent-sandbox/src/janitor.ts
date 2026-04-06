import type { SandboxLeaseJanitorOptions, SandboxLeaseJanitorReport } from "./types";

export class SandboxLeaseJanitor {
  constructor(private readonly options: SandboxLeaseJanitorOptions) {}

  async cleanupOrphans(): Promise<SandboxLeaseJanitorReport> {
    const now = (this.options.now ?? (() => new Date()))();
    const activeLeaseIds = new Set(
      this.options.factory.listActiveLeases().map((lease) => lease.leaseId),
    );
    const records = await this.options.store.list();
    const staleRecords = records.filter((record) => {
      if (activeLeaseIds.has(record.lease.leaseId)) {
        return false;
      }
      return now.getTime() - new Date(record.lastUsedAt).getTime() >= this.options.staleAfterMs;
    });

    const failures: SandboxLeaseJanitorReport["failures"] = [];
    let released = 0;

    for (const record of staleRecords) {
      try {
        await this.options.factory.release(record.lease);
        await this.options.store.delete(record.runId);
        released += 1;
      } catch (error) {
        failures.push({
          runId: record.runId,
          leaseId: record.lease.leaseId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      released,
      failed: failures.length,
      failures,
    };
  }
}

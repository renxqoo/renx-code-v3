import type {
  SandboxDoctorOptions,
  SandboxDoctorProviderReport,
  SandboxDoctorReport,
} from "./types";

export class SandboxDoctor {
  constructor(private readonly options: SandboxDoctorOptions) {}

  async inspect(): Promise<SandboxDoctorReport> {
    const providerStates = this.options.factory.listProviderStates();
    const providers: SandboxDoctorProviderReport[] = this.options.factory
      .listProviders()
      .map((provider) => {
        const state = providerStates.find((entry) => entry.kind === provider.kind);
        const descriptor = provider.describe?.() ?? state?.descriptor;
        const report: SandboxDoctorProviderReport = {
          kind: provider.kind,
          initialized: state?.initialized ?? false,
          dependencyStatus: state?.dependencyStatus ?? "unknown",
          issues: [...(state?.issues ?? [])],
          ...(state?.lastError ? { lastError: state.lastError } : {}),
          ...(descriptor ? { descriptor } : {}),
          ...(descriptor?.defaultWorkspaceRoot
            ? { defaultWorkspaceRoot: descriptor.defaultWorkspaceRoot }
            : {}),
          ...(descriptor?.isolationMode ? { isolationMode: descriptor.isolationMode } : {}),
          ...(descriptor?.supportsReconnect !== undefined
            ? { supportsReconnect: descriptor.supportsReconnect }
            : {}),
        };
        return report;
      });

    const activeLeases = this.options.factory.listActiveLeases();
    const durableRecords = await this.options.leaseStore?.list();
    const durableLeases =
      durableRecords?.map((record) => ({
        runId: record.runId,
        provider: record.provider,
        leaseId: record.lease.leaseId,
        ...(record.lease.sandboxId ? { sandboxId: record.lease.sandboxId } : {}),
        platform: record.lease.platform,
        workspaceRoot: record.lease.workspaceRoot,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
      })) ?? [];

    const warnings = new Set<string>();
    for (const provider of providers) {
      if (provider.isolationMode === "host") {
        warnings.add(
          `Provider "${provider.kind}" is a host-backed local sandbox and should be treated as non-isolated.`,
        );
      }
      if (provider.dependencyStatus === "failed" && provider.issues.length > 0) {
        warnings.add(
          `Provider "${provider.kind}" has dependency issues: ${provider.issues.join(", ")}`,
        );
      }
    }
    for (const lease of activeLeases) {
      if (lease.platform === "local") {
        warnings.add(
          `Active lease "${lease.leaseId}" is using the local sandbox platform, which is host-backed and non-isolated.`,
        );
      }
    }

    return {
      providers,
      activeLeases,
      durableLeases,
      warnings: [...warnings],
    };
  }
}

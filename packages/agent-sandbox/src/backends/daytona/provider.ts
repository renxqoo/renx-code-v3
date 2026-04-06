import { SandboxProviderError } from "../../errors";
import type {
  SandboxDependencyCheckResult,
  SandboxLease,
  SandboxProvisionRequest,
  SandboxProvider,
  SandboxProviderDescriptor,
} from "../../types";
import { DaytonaSandboxClient } from "./client";
import type {
  DaytonaSandboxBlueprint,
  DaytonaSandboxClientLike,
  DaytonaSandboxCreateRequest,
  DaytonaSandboxHandle,
  DaytonaSandboxMetadata,
  DaytonaSandboxProviderOptions,
  DaytonaSandboxReleaseMode,
  DaytonaSandboxResolvedVolume,
  DaytonaSandboxVolumeSpec,
} from "./types";
import {
  buildDaytonaLeaseMetadata,
  resolveDaytonaSandboxReference,
} from "../shared/lease-metadata";
import { reconcileManagedResource } from "../shared/managed-resource";
import { buildSandboxLease, ensureProvisionPlatform } from "../shared/provider-helpers";

const DEFAULT_PLATFORM = "daytona";
const DEFAULT_WORKSPACE_ROOT = "/workspace";
type ExistingSandbox = DaytonaSandboxHandle;

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly kind: string;

  private readonly platformKind: string;
  private readonly defaults: Omit<DaytonaSandboxBlueprint, "name">;
  private readonly releaseMode: DaytonaSandboxReleaseMode;
  private readonly client: DaytonaSandboxClientLike;

  constructor(options: DaytonaSandboxProviderOptions = {}) {
    this.kind = options.kind ?? DEFAULT_PLATFORM;
    this.platformKind = options.platform ?? DEFAULT_PLATFORM;
    this.defaults = { ...(options.defaults ?? {}) };
    this.releaseMode = options.releaseMode ?? "delete";
    this.client =
      options.client ??
      new DaytonaSandboxClient({
        ...(options.config ? { config: options.config } : {}),
      });
  }

  describe(): SandboxProviderDescriptor {
    return {
      kind: this.kind,
      defaultWorkspaceRoot: DEFAULT_WORKSPACE_ROOT,
      isolationMode: "remote",
      supportsReconnect: true,
    };
  }

  async verifyDependencies(): Promise<SandboxDependencyCheckResult> {
    try {
      await this.client.verifyConnection();
      return {
        ok: true,
        issues: [],
      };
    } catch (error) {
      return {
        ok: false,
        issues: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  async provision(request: SandboxProvisionRequest): Promise<SandboxLease> {
    ensureProvisionPlatform(request, this.platformKind, "Daytona sandbox provider");

    const blueprint = this.resolveBlueprint(request);
    this.assertBlueprint(blueprint);

    let sandbox = await this.findSandbox({
      ...(request.sandboxId ? { sandboxId: request.sandboxId } : {}),
      ...(blueprint.name ? { sandboxName: blueprint.name } : {}),
    });

    if (sandbox) {
      sandbox = await reconcileManagedResource({
        resource: sandbox,
        classify: (resource) => {
          const state = resource.state?.toLowerCase();
          if (!state || state === "started") {
            return "reuse";
          }
          if (state === "stopped" || state === "archived") {
            return "resume";
          }
          if (state === "error") {
            return resource.recoverable ? "recover" : "replace";
          }
          return "wait";
        },
        resume: async (resource) => {
          await resource.start(blueprint.timeoutSec);
          return resource;
        },
        recover: async (resource) => {
          await resource.recover(blueprint.timeoutSec);
          return resource;
        },
        wait: async (resource) => {
          await resource.waitUntilStarted(blueprint.timeoutSec);
          return resource;
        },
        replace: async (resource) => {
          await resource.delete(blueprint.timeoutSec);
        },
      });
      if (sandbox) {
        return await this.buildLease(request, sandbox, blueprint.name);
      }
    }

    const { volumes: requestedVolumes, ...baseBlueprint } = blueprint;

    const createRequest: DaytonaSandboxCreateRequest = {
      ...baseBlueprint,
      ...(requestedVolumes ? { volumes: await this.resolveVolumes(requestedVolumes) } : {}),
    };

    const created = await this.client.createSandbox(createRequest);

    return await this.buildLease(request, created, blueprint.name);
  }

  async isReady(lease: SandboxLease): Promise<boolean> {
    const sandbox = await this.findSandbox(resolveDaytonaSandboxReference(lease));
    if (!sandbox) {
      return false;
    }
    if (sandbox.state?.toLowerCase() === "started") {
      return true;
    }
    await sandbox.refreshData();
    return sandbox.state?.toLowerCase() === "started";
  }

  async release(lease: SandboxLease): Promise<void> {
    const sandbox = await this.findSandbox(resolveDaytonaSandboxReference(lease));
    if (!sandbox) {
      return;
    }

    if (this.releaseMode === "delete") {
      await sandbox.delete();
      return;
    }

    const state = sandbox.state?.toLowerCase();
    if (this.releaseMode === "stop") {
      if (state !== "stopped" && state !== "archived") {
        await sandbox.stop();
      }
      return;
    }

    if (state !== "stopped" && state !== "archived") {
      await sandbox.stop();
    }
    if (state !== "archived") {
      await sandbox.archive();
    }
  }

  private resolveBlueprint(request: SandboxProvisionRequest): DaytonaSandboxBlueprint {
    const metadata = this.asDaytonaMetadata(request.metadata);
    const overrides = metadata?.daytona ?? {};
    const labels = {
      ...(this.defaults.labels ?? {}),
      ...(overrides.labels ?? {}),
    };
    const envVars = {
      ...(this.defaults.envVars ?? {}),
      ...(overrides.envVars ?? {}),
    };

    return {
      ...this.defaults,
      ...overrides,
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
      ...(Object.keys(envVars).length > 0 ? { envVars } : {}),
      ...(overrides.name
        ? { name: overrides.name }
        : request.sandboxId
          ? { name: request.sandboxId }
          : {}),
      ...(overrides.networkBlockAll !== undefined
        ? {}
        : request.policy?.allowNetwork === false
          ? { networkBlockAll: true }
          : {}),
    };
  }

  private assertBlueprint(blueprint: DaytonaSandboxBlueprint): void {
    if (blueprint.image !== undefined && blueprint.snapshot !== undefined) {
      throw new SandboxProviderError(
        "Daytona sandbox create request cannot specify both image and snapshot.",
      );
    }
    if (blueprint.resources && blueprint.image === undefined) {
      throw new SandboxProviderError(
        "Daytona sandbox resources can only be set when creating from an image.",
      );
    }
    for (const volume of blueprint.volumes ?? []) {
      if (!volume.volumeId && !volume.volumeName) {
        throw new SandboxProviderError(
          "Daytona sandbox volume spec requires either volumeId or volumeName.",
        );
      }
    }
  }

  private async resolveVolumes(
    volumes: DaytonaSandboxVolumeSpec[],
  ): Promise<DaytonaSandboxResolvedVolume[]> {
    return await Promise.all(
      volumes.map(async (volume) => {
        const resolved = volume.volumeId
          ? await this.client.getVolumeById(volume.volumeId)
          : await this.client.getVolumeByName(volume.volumeName!, volume.createIfMissing);
        if (!resolved) {
          throw new SandboxProviderError(
            `Daytona volume not found: ${volume.volumeId ?? volume.volumeName}`,
          );
        }
        return {
          volumeId: resolved.id,
          mountPath: volume.mountPath,
          ...(volume.subpath ? { subpath: volume.subpath } : {}),
        };
      }),
    );
  }

  private async buildLease(
    request: SandboxProvisionRequest,
    sandbox: ExistingSandbox,
    requestedName?: string,
  ): Promise<SandboxLease> {
    const workspaceRoot =
      (await sandbox.getWorkDir()) ?? request.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;

    return buildSandboxLease({
      provider: this.kind,
      platform: this.platformKind,
      leaseId: request.leaseId ?? sandbox.id,
      sandboxId: sandbox.id,
      workspaceRoot,
      request,
      metadata: buildDaytonaLeaseMetadata({
        sandboxName: sandbox.name,
        ...(requestedName ? { requestedName } : {}),
      }),
    });
  }

  private async findSandbox(reference: {
    sandboxId?: string;
    sandboxName?: string;
  }): Promise<ExistingSandbox | undefined> {
    if (reference.sandboxId) {
      const sandbox = await this.client.getSandbox(reference.sandboxId);
      if (sandbox) {
        return sandbox;
      }
    }

    if (reference.sandboxName) {
      return await this.client.getSandbox(reference.sandboxName);
    }

    return undefined;
  }

  private asDaytonaMetadata(
    metadata: Record<string, unknown> | undefined,
  ): DaytonaSandboxMetadata | undefined {
    if (!metadata || typeof metadata !== "object") {
      return undefined;
    }
    return metadata as DaytonaSandboxMetadata;
  }
}

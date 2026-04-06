import {
  Daytona,
  DaytonaNotFoundError,
  type CreateSandboxBaseParams,
  type CreateSandboxFromImageParams,
  type CreateSandboxFromSnapshotParams,
  type DaytonaConfig,
  type Sandbox,
  type VolumeMount,
} from "@daytonaio/sdk";

import type {
  DaytonaSandboxClientLike,
  DaytonaSandboxCreateRequest,
  DaytonaSandboxHandle,
  DaytonaSandboxVolumeHandle,
} from "./types";

export interface DaytonaSandboxClientOptions {
  config?: DaytonaConfig;
}

export class DaytonaSandboxClient implements DaytonaSandboxClientLike {
  private readonly daytona: Daytona;

  constructor(options: DaytonaSandboxClientOptions = {}) {
    this.daytona = new Daytona(options.config);
  }

  async verifyConnection(): Promise<void> {
    await this.daytona.list(undefined, 1, 1);
  }

  async getSandbox(idOrName: string): Promise<DaytonaSandboxHandle | undefined> {
    try {
      return this.asHandle(await this.daytona.get(idOrName));
    } catch (error) {
      if (error instanceof DaytonaNotFoundError) {
        return undefined;
      }
      throw error;
    }
  }

  async createSandbox(request: DaytonaSandboxCreateRequest): Promise<DaytonaSandboxHandle> {
    const base: CreateSandboxBaseParams = {
      ...(request.name ? { name: request.name } : {}),
      ...(request.user ? { user: request.user } : {}),
      ...(request.language ? { language: request.language } : {}),
      ...(request.envVars ? { envVars: request.envVars } : {}),
      ...(request.labels ? { labels: request.labels } : {}),
      ...(request.public !== undefined ? { public: request.public } : {}),
      ...(request.autoStopInterval !== undefined
        ? { autoStopInterval: request.autoStopInterval }
        : {}),
      ...(request.autoArchiveInterval !== undefined
        ? { autoArchiveInterval: request.autoArchiveInterval }
        : {}),
      ...(request.autoDeleteInterval !== undefined
        ? { autoDeleteInterval: request.autoDeleteInterval }
        : {}),
      ...(request.volumes
        ? {
            volumes: request.volumes.map<VolumeMount>((volume) => ({
              volumeId: volume.volumeId,
              mountPath: volume.mountPath,
              ...(volume.subpath ? { subpath: volume.subpath } : {}),
            })),
          }
        : {}),
      ...(request.networkBlockAll !== undefined
        ? { networkBlockAll: request.networkBlockAll }
        : {}),
      ...(request.networkAllowList ? { networkAllowList: request.networkAllowList } : {}),
      ...(request.ephemeral !== undefined ? { ephemeral: request.ephemeral } : {}),
    };

    const sandbox =
      request.image !== undefined
        ? await this.daytona.create(
            {
              ...base,
              image: request.image,
              ...(request.resources ? { resources: request.resources } : {}),
            } satisfies CreateSandboxFromImageParams,
            {
              ...(request.timeoutSec !== undefined ? { timeout: request.timeoutSec } : {}),
              ...(request.onSnapshotCreateLogs
                ? { onSnapshotCreateLogs: request.onSnapshotCreateLogs }
                : {}),
            },
          )
        : await this.daytona.create(
            {
              ...base,
              ...(request.snapshot ? { snapshot: request.snapshot } : {}),
            } satisfies CreateSandboxFromSnapshotParams,
            {
              ...(request.timeoutSec !== undefined ? { timeout: request.timeoutSec } : {}),
            },
          );

    return this.asHandle(sandbox);
  }

  async getVolumeByName(
    name: string,
    createIfMissing = false,
  ): Promise<DaytonaSandboxVolumeHandle> {
    return await this.daytona.volume.get(name, createIfMissing);
  }

  async getVolumeById(volumeId: string): Promise<DaytonaSandboxVolumeHandle | undefined> {
    const volumes = await this.daytona.volume.list();
    return volumes.find((volume) => volume.id === volumeId);
  }

  private asHandle(sandbox: Sandbox): DaytonaSandboxHandle {
    return sandbox;
  }
}

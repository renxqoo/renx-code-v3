import { SandboxProviderError } from "../../errors";
import { createSandboxId } from "../../path-utils";
import type {
  SandboxDependencyCheckResult,
  SandboxLease,
  SandboxProvisionRequest,
  SandboxProvider,
  SandboxProviderDescriptor,
} from "../../types";
import { buildRemoteLeaseMetadata } from "../shared/lease-metadata";
import { reconcileManagedResource } from "../shared/managed-resource";
import {
  buildSandboxLease,
  ensureAbsolutePosixWorkspaceRoot,
  ensureProvisionPlatform,
} from "../shared/provider-helpers";
import { RemoteSandboxClient } from "./client";
import type { RemoteSandboxTransport } from "./transport";

export interface RemoteSandboxProviderOptions {
  kind?: string;
  platform?: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  workspaceRoot?: string;
  transport?: RemoteSandboxTransport;
}

const DEFAULT_PLATFORM = "remote-http";
const DEFAULT_WORKSPACE_ROOT = "/workspace";

export class RemoteSandboxProvider implements SandboxProvider {
  readonly kind: string;

  private readonly platformKind: string;
  private readonly workspaceRoot: string;
  private readonly baseUrl: string;
  private readonly client: RemoteSandboxClient;

  constructor(options: RemoteSandboxProviderOptions) {
    this.kind = options.kind ?? DEFAULT_PLATFORM;
    this.platformKind = options.platform ?? DEFAULT_PLATFORM;
    this.workspaceRoot = options.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.client = new RemoteSandboxClient({
      baseUrl: this.baseUrl,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.transport ? { transport: options.transport } : {}),
    });
  }

  describe(): SandboxProviderDescriptor {
    return {
      kind: this.kind,
      defaultWorkspaceRoot: this.workspaceRoot,
      isolationMode: "remote",
      supportsReconnect: true,
    };
  }

  async verifyDependencies(): Promise<SandboxDependencyCheckResult> {
    try {
      const response = await this.client.health();
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, issues: [] };
      }
      return {
        ok: false,
        issues: [`Remote sandbox health check failed with status ${response.status}.`],
      };
    } catch (error) {
      return {
        ok: false,
        issues: [
          `Remote sandbox health check failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  async provision(request: SandboxProvisionRequest): Promise<SandboxLease> {
    ensureProvisionPlatform(request, this.platformKind, "Remote sandbox provider");

    const workspaceRoot = request.workspaceRoot ?? this.workspaceRoot;
    ensureAbsolutePosixWorkspaceRoot(workspaceRoot, "Remote sandbox");

    const leaseId = request.leaseId ?? createSandboxId("lease");
    const sandboxId = request.sandboxId ?? createSandboxId("sandbox");
    const existing = await this.client.getSandbox(sandboxId);
    const reusable = await reconcileManagedResource({
      resource: existing,
      classify: (resource) => {
        const status = resource.status?.toLowerCase();
        return status === "failed" || status === "terminated" ? "replace" : "reuse";
      },
      replace: async () => {
        await this.client.deleteSandbox(sandboxId);
      },
    });

    if (reusable) {
      return buildSandboxLease({
        provider: this.kind,
        platform: this.platformKind,
        leaseId,
        sandboxId,
        workspaceRoot: reusable.workspaceRoot || workspaceRoot,
        ...(reusable.mountPath ? { mountPath: reusable.mountPath } : {}),
        request,
        metadata: buildRemoteLeaseMetadata({
          sandboxBaseUrl: this.baseUrl,
        }),
      });
    }

    const created = await this.client.createSandbox({
      sandboxId,
      workspaceRoot,
      ...(request.mountPath ? { mountPath: request.mountPath } : {}),
      ...(request.snapshotId ? { snapshotId: request.snapshotId } : {}),
      ...(request.policy ? { policy: request.policy as Record<string, unknown> } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
    });

    return buildSandboxLease({
      provider: this.kind,
      platform: this.platformKind,
      leaseId,
      sandboxId,
      workspaceRoot: created.workspaceRoot || workspaceRoot,
      ...(created.mountPath ? { mountPath: created.mountPath } : {}),
      request,
      metadata: buildRemoteLeaseMetadata({
        sandboxBaseUrl: this.baseUrl,
      }),
    });
  }

  async isReady(lease: SandboxLease): Promise<boolean> {
    const sandboxId = lease.sandboxId ?? lease.leaseId;
    const sandbox = await this.client.getSandbox(sandboxId);
    const status = sandbox?.status?.toLowerCase();
    return !!sandbox && (!!status ? status === "ready" || status === "running" : true);
  }

  async release(lease: SandboxLease): Promise<void> {
    await this.client.deleteSandbox(lease.sandboxId ?? lease.leaseId);
  }
}

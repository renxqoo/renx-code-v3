import type { FileInfo } from "@renx/agent";

import { createFetchRemoteSandboxTransport } from "./transport";
import { formatTransportErrorMessage, throwSandboxSurfaceError } from "../shared/surface-errors";
import type {
  FetchRemoteSandboxTransportOptions,
  RemoteSandboxResponse,
  RemoteSandboxTransport,
} from "./transport";

export interface RemoteSandboxSummary {
  sandboxId: string;
  workspaceRoot: string;
  mountPath?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

export interface RemoteExecResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs?: number;
  truncated?: boolean;
}

export interface RemoteUploadResponse {
  files: Array<{ path: string; error?: string }>;
}

export interface RemoteDownloadResponse {
  files: Array<{ path: string; base64?: string; error?: string }>;
}

export interface RemoteListResponse {
  entries: Array<FileInfo>;
}

export interface RemoteStatResponse {
  entry?: FileInfo;
}

export interface RemoteSandboxClientOptions {
  baseUrl: string;
  transport?: RemoteSandboxTransport;
  apiKey?: string;
  headers?: Record<string, string>;
}

export class RemoteSandboxClient {
  private readonly baseUrl: string;
  private readonly transport: RemoteSandboxTransport;

  constructor(options: RemoteSandboxClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.transport =
      options.transport ??
      createFetchRemoteSandboxTransport({
        baseUrl: this.baseUrl,
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
      } satisfies FetchRemoteSandboxTransportOptions);
  }

  async health(): Promise<RemoteSandboxResponse> {
    return await this.transport({
      method: "GET",
      path: "/health",
    });
  }

  async getSandbox(sandboxId: string): Promise<RemoteSandboxSummary | undefined> {
    const response = await this.transport({
      method: "GET",
      path: `/sandboxes/${sandboxId}`,
    });
    if (response.status === 404) {
      return undefined;
    }
    return this.expectOk<RemoteSandboxSummary>(response, "provider");
  }

  async createSandbox(request: {
    sandboxId: string;
    workspaceRoot: string;
    mountPath?: string;
    snapshotId?: string;
    policy?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<RemoteSandboxSummary> {
    const response = await this.transport({
      method: "POST",
      path: "/sandboxes",
      body: {
        sandboxId: request.sandboxId,
        workspaceRoot: request.workspaceRoot,
        ...(request.mountPath ? { mountPath: request.mountPath } : {}),
        ...(request.snapshotId ? { snapshotId: request.snapshotId } : {}),
        ...(request.policy ? { policy: request.policy } : {}),
        ...(request.metadata ? { metadata: request.metadata } : {}),
      },
    });
    return this.expectOk<RemoteSandboxSummary>(response, "provider");
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    const response = await this.transport({
      method: "DELETE",
      path: `/sandboxes/${sandboxId}`,
    });
    if (response.status === 404 || response.status === 204 || response.status === 200) {
      return;
    }
    this.expectOk(response, "provider");
  }

  async exec(request: {
    sandboxId: string;
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    stdin?: string;
    metadata?: Record<string, unknown>;
  }): Promise<RemoteExecResponse> {
    const response = await this.transport({
      method: "POST",
      path: `/sandboxes/${request.sandboxId}/exec`,
      body: {
        command: request.command,
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.env ? { env: request.env } : {}),
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
        ...(request.metadata ? { metadata: request.metadata } : {}),
      },
    });
    return this.expectOk<RemoteExecResponse>(response, "platform");
  }

  async uploadFiles(request: {
    sandboxId: string;
    files: Array<{ path: string; content: Uint8Array }>;
  }): Promise<RemoteUploadResponse> {
    const response = await this.transport({
      method: "POST",
      path: `/sandboxes/${request.sandboxId}/files:upload`,
      body: {
        files: request.files.map((file) => ({
          path: file.path,
          base64: Buffer.from(file.content).toString("base64"),
        })),
      },
    });
    return this.expectOk<RemoteUploadResponse>(response, "platform");
  }

  async downloadFiles(request: {
    sandboxId: string;
    paths: string[];
  }): Promise<RemoteDownloadResponse> {
    const response = await this.transport({
      method: "POST",
      path: `/sandboxes/${request.sandboxId}/files:download`,
      body: {
        paths: request.paths,
      },
    });
    return this.expectOk<RemoteDownloadResponse>(response, "platform");
  }

  async listFiles(request: { sandboxId: string; path: string }): Promise<RemoteListResponse> {
    const response = await this.transport({
      method: "POST",
      path: `/sandboxes/${request.sandboxId}/files:list`,
      body: {
        path: request.path,
      },
    });
    return this.expectOk<RemoteListResponse>(response, "platform");
  }

  async statPath(request: { sandboxId: string; path: string }): Promise<RemoteStatResponse> {
    const response = await this.transport({
      method: "POST",
      path: `/sandboxes/${request.sandboxId}/files:stat`,
      body: {
        path: request.path,
      },
    });
    return this.expectOk<RemoteStatResponse>(response, "platform");
  }

  async deletePaths(request: { sandboxId: string; paths: string[] }): Promise<void> {
    const response = await this.transport({
      method: "POST",
      path: `/sandboxes/${request.sandboxId}/files:delete`,
      body: {
        paths: request.paths,
      },
    });
    this.expectOk(response, "platform");
  }

  private expectOk<T>(response: RemoteSandboxResponse, surface: "provider" | "platform"): T {
    if (response.status >= 200 && response.status < 300) {
      return response.body as T;
    }

    return throwSandboxSurfaceError(
      surface,
      formatTransportErrorMessage("Remote sandbox request failed", response.status, response.body),
    );
  }
}

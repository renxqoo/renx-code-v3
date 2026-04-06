import { SandboxPlatformError } from "../../errors";
import type {
  SandboxFileDownloadResult,
  SandboxFileUploadResult,
  SandboxLease,
  SandboxRuntimeConnection,
} from "../../types";
import { ConnectionSandboxPlatform } from "../../platform/connection-platform";
import { resolveRemoteSandboxBaseUrl } from "../shared/lease-metadata";
import { RemoteSandboxClient } from "./client";
import type { RemoteSandboxTransport } from "./transport";

export interface RemoteSandboxPlatformOptions {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  transport?: RemoteSandboxTransport;
  kind?: string;
}

const DEFAULT_PLATFORM = "remote-http";

export class RemoteSandboxPlatform extends ConnectionSandboxPlatform {
  readonly kind: string;

  private readonly defaultBaseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly headers: Record<string, string> | undefined;
  private readonly transport: RemoteSandboxTransport | undefined;

  constructor(options: RemoteSandboxPlatformOptions) {
    super();
    this.kind = options.kind ?? DEFAULT_PLATFORM;
    this.defaultBaseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.headers = options.headers;
    this.transport = options.transport;
  }

  protected async connect(lease: SandboxLease): Promise<SandboxRuntimeConnection> {
    const sandboxId = lease.sandboxId ?? lease.leaseId;
    const baseUrl = resolveRemoteSandboxBaseUrl(lease, this.defaultBaseUrl);
    if (!baseUrl) {
      throw new SandboxPlatformError(
        `Remote sandbox lease ${lease.leaseId} is missing sandbox base URL.`,
      );
    }

    const client = new RemoteSandboxClient({
      baseUrl,
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
      ...(this.headers ? { headers: this.headers } : {}),
      ...(this.transport ? { transport: this.transport } : {}),
    });

    return {
      id: `remote:${sandboxId}`,
      execute: async (request) => {
        const result = await client.exec({
          sandboxId,
          command: request.command,
          ...(request.cwd ? { cwd: request.cwd } : {}),
          ...(request.env ? { env: request.env } : {}),
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
          ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
          ...(request.metadata ? { metadata: request.metadata } : {}),
        });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
          ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
        };
      },
      uploadFiles: async (files): Promise<SandboxFileUploadResult[]> => {
        const result = await client.uploadFiles({
          sandboxId,
          files,
        });
        return result.files.map((file) => ({
          path: file.path,
          ...(file.error ? { error: file.error } : {}),
        }));
      },
      downloadFiles: async (paths): Promise<SandboxFileDownloadResult[]> => {
        const result = await client.downloadFiles({
          sandboxId,
          paths,
        });
        return result.files.map((file) => ({
          path: file.path,
          ...(file.base64
            ? {
                content: Uint8Array.from(Buffer.from(file.base64, "base64")),
              }
            : {}),
          ...(file.error ? { error: file.error } : {}),
        }));
      },
      listFiles: async (path) => (await client.listFiles({ sandboxId, path })).entries,
      statPath: async (path) => (await client.statPath({ sandboxId, path })).entry,
      deletePaths: async (paths) => {
        await client.deletePaths({ sandboxId, paths });
      },
      dispose: async () => {},
    };
  }
}

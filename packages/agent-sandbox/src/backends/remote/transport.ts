export interface RemoteSandboxRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface RemoteSandboxResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export type RemoteSandboxTransport = (
  request: RemoteSandboxRequest,
) => Promise<RemoteSandboxResponse>;

export interface FetchRemoteSandboxTransportOptions {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export const createFetchRemoteSandboxTransport = (
  options: FetchRemoteSandboxTransportOptions,
): RemoteSandboxTransport => {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  return async (request: RemoteSandboxRequest): Promise<RemoteSandboxResponse> => {
    const response = await fetch(`${baseUrl}${request.path}`, {
      method: request.method,
      headers: {
        "content-type": "application/json",
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        ...(options.headers ?? {}),
        ...(request.headers ?? {}),
      },
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      ...(request.timeoutMs && request.timeoutMs > 0
        ? { signal: AbortSignal.timeout(request.timeoutMs) }
        : {}),
    });

    const contentType = response.headers.get("content-type") ?? "";
    const body =
      response.status === 204
        ? undefined
        : contentType.includes("application/json")
          ? await response.json()
          : await response.text();

    return {
      status: response.status,
      ...(body !== undefined ? { body } : {}),
      headers: Object.fromEntries(response.headers.entries()),
    };
  };
};

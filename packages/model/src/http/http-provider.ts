import type { Provider } from "../provider";
import type { ProviderRequest, ProviderResponse } from "../types";
import type { AuthProvider } from "./auth-provider";

export class HttpProviderError extends Error {
  constructor(
    message: string,
    public readonly response: ProviderResponse,
  ) {
    super(message);
    this.name = "HttpProviderError";
  }
}

export interface HttpProviderOptions {
  authProvider?: AuthProvider;
  defaultTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  name?: string;
}

export class HttpProvider implements Provider {
  name: string;

  private readonly authProvider: AuthProvider | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpProviderOptions = {}) {
    this.name = options.name ?? "http";
    this.authProvider = options.authProvider;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    const authHeaders = this.authProvider ? await this.authProvider.getHeaders() : {};
    const response = await this.fetchImpl(request.url, {
      method: request.method ?? "POST",
      headers: {
        ...authHeaders,
        ...request.headers,
      },
      body: serializeRequestBody(request.body),
      signal: AbortSignal.timeout(request.timeoutMs ?? this.defaultTimeoutMs),
    });

    const parsedBody = await parseResponseBody(response);
    const providerResponse: ProviderResponse = {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: parsedBody,
      raw: parsedBody,
    };

    if (!response.ok) {
      throw new HttpProviderError(
        `Provider request failed with status ${response.status}`,
        providerResponse,
      );
    }

    return providerResponse;
  }
}

const serializeRequestBody = (body: unknown): string => {
  return typeof body === "string" ? body : JSON.stringify(body);
};

const parseResponseBody = async (response: Response): Promise<unknown> => {
  const rawText = await response.text();

  if (rawText.length === 0) {
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(rawText) as unknown;
    } catch {
      return rawText;
    }
  }

  return rawText;
};

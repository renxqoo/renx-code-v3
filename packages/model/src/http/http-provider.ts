import type { StreamingProvider } from "../provider";
import type { ProviderRequest, ProviderResponse, ProviderStreamChunk } from "../types";
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

export interface HttpTransportRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

export interface HttpProviderOptions {
  authProvider?: AuthProvider;
  fetchImpl?: typeof fetch;
  name?: string;
  transportRetry?: HttpTransportRetryOptions;
}

export class HttpProvider implements StreamingProvider {
  name: string;

  private readonly authProvider: AuthProvider | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly transportRetryMax: number;
  private readonly transportRetryBaseDelayMs: number;

  constructor(options: HttpProviderOptions = {}) {
    this.name = options.name ?? "http";
    this.authProvider = options.authProvider;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.transportRetryMax = options.transportRetry?.maxRetries ?? 2;
    this.transportRetryBaseDelayMs = options.transportRetry?.baseDelayMs ?? 200;
  }

  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.rawFetch(request);
        const parsedBody = await parseResponseBody(response);

        return {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: parsedBody,
          raw: parsedBody,
        };
      } catch (error) {
        if (attempt >= this.transportRetryMax || !isTransientError(error)) {
          throw error;
        }

        await transportBackoff(attempt, this.transportRetryBaseDelayMs);
      }
    }
  }

  async *executeStream(request: ProviderRequest): AsyncIterable<ProviderStreamChunk> {
    let response: Response;

    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await this.rawFetch(request);
        break;
      } catch (error) {
        if (attempt >= this.transportRetryMax || !isTransientError(error)) {
          throw error;
        }

        await transportBackoff(attempt, this.transportRetryBaseDelayMs);
      }
    }

    const reader = response.body?.getReader();

    if (!reader) {
      throw new Error("Response body is not readable");
    }

    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        yield { raw: decoder.decode(value, { stream: true }) };
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async rawFetch(request: ProviderRequest): Promise<Response> {
    const signal = this.buildSignal(request.signal, request.timeoutMs);
    const authHeaders = this.authProvider ? await this.authProvider.getHeaders() : {};

    const response = await this.fetchImpl(request.url, {
      method: request.method ?? "POST",
      headers: { ...authHeaders, ...request.headers },
      body: serializeRequestBody(request.body),
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      const parsedBody = await parseResponseBody(response);

      throw new HttpProviderError(`Provider request failed with status ${response.status}`, {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: parsedBody,
        raw: parsedBody,
      });
    }

    return response;
  }

  private buildSignal(external?: AbortSignal, requestTimeoutMs?: number): AbortSignal | undefined {
    if (requestTimeoutMs === undefined) {
      return external;
    }

    const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
    if (external === undefined) {
      return timeoutSignal;
    }
    return AbortSignal.any([external, timeoutSignal]);
  }
}

const isTransientError = (error: unknown): boolean => {
  if (error instanceof TypeError) {
    return true;
  }

  if (error instanceof HttpProviderError) {
    const status = error.response.status;

    return status === 502 || status === 503 || status === 504;
  }

  return false;
};

const transportBackoff = async (attempt: number, baseDelayMs: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, baseDelayMs * 2 ** attempt);
  });
};

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

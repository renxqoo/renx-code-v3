import type { StreamingProvider } from "../provider";
import type { ProviderRequest, ProviderResponse, ProviderStreamChunk } from "../types";
import type { AuthProvider } from "./auth-provider";
export declare class HttpProviderError extends Error {
    readonly response: ProviderResponse;
    constructor(message: string, response: ProviderResponse);
}
export interface HttpTransportRetryOptions {
    maxRetries?: number;
    baseDelayMs?: number;
}
export interface HttpProviderOptions {
    authProvider?: AuthProvider;
    defaultTimeoutMs?: number;
    fetchImpl?: typeof fetch;
    name?: string;
    transportRetry?: HttpTransportRetryOptions;
}
export declare class HttpProvider implements StreamingProvider {
    name: string;
    private readonly authProvider;
    private readonly defaultTimeoutMs;
    private readonly fetchImpl;
    private readonly transportRetryMax;
    private readonly transportRetryBaseDelayMs;
    constructor(options?: HttpProviderOptions);
    execute(request: ProviderRequest): Promise<ProviderResponse>;
    executeStream(request: ProviderRequest): AsyncIterable<ProviderStreamChunk>;
    private rawFetch;
    private buildSignal;
}
//# sourceMappingURL=http-provider.d.ts.map
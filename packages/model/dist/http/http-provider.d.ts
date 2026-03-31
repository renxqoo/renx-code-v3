import type { Provider } from "../provider";
import type { ProviderRequest, ProviderResponse } from "../types";
import type { AuthProvider } from "./auth-provider";
export declare class HttpProviderError extends Error {
    readonly response: ProviderResponse;
    constructor(message: string, response: ProviderResponse);
}
export interface HttpProviderOptions {
    authProvider?: AuthProvider;
    defaultTimeoutMs?: number;
    fetchImpl?: typeof fetch;
    name?: string;
}
export declare class HttpProvider implements Provider {
    name: string;
    private readonly authProvider;
    private readonly defaultTimeoutMs;
    private readonly fetchImpl;
    constructor(options?: HttpProviderOptions);
    execute(request: ProviderRequest): Promise<ProviderResponse>;
}
//# sourceMappingURL=http-provider.d.ts.map
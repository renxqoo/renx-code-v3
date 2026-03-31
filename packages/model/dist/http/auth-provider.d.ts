export interface AuthProvider {
    getHeaders(): Promise<Record<string, string>> | Record<string, string>;
}
export declare class StaticHeaderAuthProvider implements AuthProvider {
    private readonly headers;
    constructor(headers: Record<string, string>);
    getHeaders(): Record<string, string>;
}
export declare class ApiKeyAuthProvider implements AuthProvider {
    private readonly apiKey;
    private readonly headerName;
    private readonly scheme;
    constructor(apiKey: string, headerName?: string, scheme?: string);
    getHeaders(): Record<string, string>;
}
//# sourceMappingURL=auth-provider.d.ts.map
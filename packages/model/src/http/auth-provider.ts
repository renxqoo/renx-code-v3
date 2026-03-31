export interface AuthProvider {
  getHeaders(): Promise<Record<string, string>> | Record<string, string>;
}

export class StaticHeaderAuthProvider implements AuthProvider {
  constructor(private readonly headers: Record<string, string>) {}

  getHeaders(): Record<string, string> {
    return { ...this.headers };
  }
}

export class ApiKeyAuthProvider implements AuthProvider {
  constructor(
    private readonly apiKey: string,
    private readonly headerName = "Authorization",
    private readonly scheme = "Bearer",
  ) {}

  getHeaders(): Record<string, string> {
    const value = this.scheme.length > 0 ? `${this.scheme} ${this.apiKey}` : this.apiKey;

    return {
      [this.headerName]: value,
    };
  }
}

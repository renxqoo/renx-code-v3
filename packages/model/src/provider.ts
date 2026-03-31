import type { ProviderRequest, ProviderResponse, ProviderStreamChunk } from "./types";

export interface Provider {
  name: string;
  execute(request: ProviderRequest): Promise<ProviderResponse>;
}

export interface StreamingProvider extends Provider {
  executeStream?(request: ProviderRequest): AsyncIterable<ProviderStreamChunk>;
}

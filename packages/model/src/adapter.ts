import type { NormalizedModelError } from "./errors";
import type { Provider } from "./provider";
import type {
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ProviderRequest,
  ProviderResponse,
} from "./types";

export interface ModelAdapter {
  name: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
  describeRequest?(
    request: ModelRequest,
  ): Promise<ModelAdapterRequestDescriptor> | ModelAdapterRequestDescriptor;
  stream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}

export interface ModelAdapterRequestDescriptor {
  endpoint: string;
  method: ProviderRequest["method"];
}

export abstract class BaseModelAdapter implements ModelAdapter {
  abstract name: string;

  constructor(protected readonly provider: Provider) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    try {
      const providerRequest = await this.toProviderRequest(request);
      const providerResponse = await this.provider.execute(providerRequest);

      return await this.fromProviderResponse(providerResponse, request);
    } catch (error) {
      throw await this.normalizeError(error, request);
    }
  }

  async describeRequest(request: ModelRequest): Promise<ModelAdapterRequestDescriptor> {
    const providerRequest = await this.toProviderRequest(request);

    return {
      endpoint: providerRequest.url,
      method: providerRequest.method ?? "POST",
    };
  }

  protected abstract toProviderRequest(
    request: ModelRequest,
  ): Promise<ProviderRequest> | ProviderRequest;

  protected abstract fromProviderResponse(
    response: ProviderResponse,
    request: ModelRequest,
  ): Promise<ModelResponse> | ModelResponse;

  protected abstract normalizeError(
    error: unknown,
    request: ModelRequest,
  ): Promise<NormalizedModelError> | NormalizedModelError;
}

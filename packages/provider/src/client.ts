import {
  createModelClient as createBaseModelClient,
  type ModelClient,
  type ModelProvider,
  type ModelResolver,
  type ModelRetryOptions,
  type RegisteredModel,
} from "@renx/model";

export interface CreateModelClientOptions {
  providers: ModelProvider[];
  resolveModel?: ModelResolver;
  retry?: ModelRetryOptions | false;
}

export const createModelClient = (options: CreateModelClientOptions): ModelClient => {
  const providers = options.providers;

  if (providers.length === 0) {
    throw new Error("At least one provider must be configured.");
  }

  return createBaseModelClient({
    providers,
    resolveModel: options.resolveModel ?? createInferResolver(providers),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  });
};

/**
 * Resolver that only accepts explicit "provider:model" format.
 * Use this when you want strict control and no magic inference.
 */
export const createPrefixResolver = (validProviders: string[]): ModelResolver => {
  const valid = new Set(validProviders);

  return (model: string): RegisteredModel => {
    const index = model.indexOf(":");

    if (index === -1) {
      throw new Error(`Model must use "provider:model" format, got: "${model}"`);
    }

    const provider = model.slice(0, index);
    const providerModel = model.slice(index + 1);

    if (!providerModel) {
      throw new Error(`Invalid model: "${model}"`);
    }

    if (!valid.has(provider)) {
      throw new Error(`Provider not configured: ${provider}`);
    }

    return { id: model, provider, providerModel };
  };
};

/**
 * Default resolver: tries explicit "provider:model" first,
 * then falls back to each provider's inferModel function.
 */
export const createInferResolver = (providers: ModelProvider[]): ModelResolver => {
  const validNames = new Set(providers.map((p) => p.name));

  return (model: string): RegisteredModel => {
    const index = model.indexOf(":");

    if (index !== -1) {
      const provider = model.slice(0, index);
      const providerModel = model.slice(index + 1);

      if (!providerModel) {
        throw new Error(`Invalid model: "${model}"`);
      }

      if (!validNames.has(provider)) {
        throw new Error(`Provider not configured: ${provider}`);
      }

      return { id: model, provider, providerModel };
    }

    for (const p of providers) {
      if (!p.inferModel) continue;

      const providerModel = p.inferModel(model);

      if (providerModel !== null) {
        return { id: model, provider: p.name, providerModel };
      }
    }

    throw new Error(`Cannot infer provider from model: "${model}"`);
  };
};

export type ManagedResourceDisposition = "reuse" | "resume" | "recover" | "wait" | "replace";

export interface ReconcileManagedResourceOptions<T> {
  resource: T | undefined;
  classify(resource: T): ManagedResourceDisposition;
  resume?(resource: T): Promise<T> | T;
  recover?(resource: T): Promise<T> | T;
  wait?(resource: T): Promise<T> | T;
  replace?(resource: T): Promise<void> | void;
}

const requireHandler = <T>(
  disposition: ManagedResourceDisposition,
  handler: ((resource: T) => Promise<T> | T) | undefined,
): ((resource: T) => Promise<T> | T) => {
  if (!handler) {
    throw new Error(`Missing managed resource handler for disposition: ${disposition}`);
  }
  return handler;
};

export const reconcileManagedResource = async <T>(
  options: ReconcileManagedResourceOptions<T>,
): Promise<T | undefined> => {
  if (!options.resource) {
    return undefined;
  }

  const disposition = options.classify(options.resource);
  switch (disposition) {
    case "reuse":
      return options.resource;
    case "resume":
      return await requireHandler("resume", options.resume)(options.resource);
    case "recover":
      return await requireHandler("recover", options.recover)(options.resource);
    case "wait":
      return await requireHandler("wait", options.wait)(options.resource);
    case "replace":
      await options.replace?.(options.resource);
      return undefined;
  }
};

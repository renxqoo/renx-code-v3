import { SandboxPlatformError, SandboxProviderError } from "../../errors";

export type SandboxErrorSurface = "provider" | "platform";

export const formatTransportErrorMessage = (
  prefix: string,
  status: number,
  body?: unknown,
): string => {
  const bodyText = typeof body === "string" ? body : body !== undefined ? JSON.stringify(body) : "";
  return `${prefix} with status ${status}${bodyText ? `: ${bodyText}` : ""}`;
};

export const throwSandboxSurfaceError = (surface: SandboxErrorSurface, message: string): never => {
  if (surface === "platform") {
    throw new SandboxPlatformError(message);
  }
  throw new SandboxProviderError(message);
};

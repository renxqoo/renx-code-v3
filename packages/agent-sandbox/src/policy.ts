import { SandboxPolicyError } from "./errors";
import type { SandboxCommandPolicy, SandboxExecRequest } from "./types";

export const DEFAULT_SANDBOX_POLICY: SandboxCommandPolicy = {
  allowNetwork: false,
  allowedWriteRoots: [],
  blockedCommandPatterns: [],
  maxExecutionTimeoutMs: 120_000,
};

export const resolveSandboxPolicy = (
  policy?: Partial<SandboxCommandPolicy>,
): SandboxCommandPolicy => ({
  ...DEFAULT_SANDBOX_POLICY,
  ...(policy ?? {}),
  allowedWriteRoots: [...(policy?.allowedWriteRoots ?? DEFAULT_SANDBOX_POLICY.allowedWriteRoots)],
  blockedCommandPatterns: [
    ...(policy?.blockedCommandPatterns ?? DEFAULT_SANDBOX_POLICY.blockedCommandPatterns),
  ],
  ...(policy?.allowedEnvironmentKeys
    ? { allowedEnvironmentKeys: [...policy.allowedEnvironmentKeys] }
    : {}),
});

export const mergeSandboxPolicy = (
  base?: Partial<SandboxCommandPolicy>,
  override?: Partial<SandboxCommandPolicy>,
): Partial<SandboxCommandPolicy> => ({
  ...(base ?? {}),
  ...(override ?? {}),
  allowedWriteRoots: [...(base?.allowedWriteRoots ?? []), ...(override?.allowedWriteRoots ?? [])],
  blockedCommandPatterns: [
    ...(base?.blockedCommandPatterns ?? []),
    ...(override?.blockedCommandPatterns ?? []),
  ],
  ...(override?.allowedEnvironmentKeys
    ? { allowedEnvironmentKeys: [...override.allowedEnvironmentKeys] }
    : base?.allowedEnvironmentKeys
      ? { allowedEnvironmentKeys: [...base.allowedEnvironmentKeys] }
      : {}),
});

export const assertSandboxExecPolicy = (
  policy: SandboxCommandPolicy,
  request: SandboxExecRequest,
): void => {
  if ((request.timeoutMs ?? policy.maxExecutionTimeoutMs) > policy.maxExecutionTimeoutMs) {
    throw new SandboxPolicyError("Execution timeout exceeds sandbox policy.");
  }
  for (const pattern of policy.blockedCommandPatterns) {
    if (pattern.test(request.command)) {
      throw new SandboxPolicyError(`Sandbox policy blocked command: ${request.command}`);
    }
  }
  if (
    !policy.allowNetwork &&
    /\b(curl|wget|invoke-webrequest|invoke-restmethod)\b/i.test(request.command)
  ) {
    throw new SandboxPolicyError("Sandbox policy blocked network access.");
  }
};

export const sanitizeSandboxEnvironment = (
  policy: SandboxCommandPolicy,
  env: Record<string, string> | undefined,
): Record<string, string> | undefined => {
  if (!env) return undefined;
  if (!policy.allowedEnvironmentKeys || policy.allowedEnvironmentKeys.length === 0) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => policy.allowedEnvironmentKeys!.includes(key)),
  );
};

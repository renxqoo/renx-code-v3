import type { AgentMiddleware } from "@renx/agent";

import { ManagedSandboxBackendResolver } from "./managed-resolver";
import type {
  CreateSandboxAgentIntegrationOptions,
  SandboxAgentIntegration,
  SandboxLifecycleMiddlewareOptions,
} from "./types";

export const createSandboxLifecycleMiddleware = (
  options: SandboxLifecycleMiddlewareOptions,
): AgentMiddleware => ({
  name: "sandbox-lifecycle",
  afterRun: async (ctx) => {
    await options.releaseRun(ctx.state.runId);
  },
});

export const createSandboxAgentIntegration = (
  options: CreateSandboxAgentIntegrationOptions,
): SandboxAgentIntegration => {
  const resolver = new ManagedSandboxBackendResolver(options);
  return {
    backend: resolver,
    middleware: [
      createSandboxLifecycleMiddleware({
        releaseRun: async (runId) => {
          await resolver.releaseRun(runId);
        },
      }),
    ],
  };
};

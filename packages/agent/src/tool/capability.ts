import type { AgentTool } from "./types";

export type ToolRiskLevel = "low" | "medium" | "high" | "critical";
export type ToolSandboxExpectation = "read-only" | "workspace-write" | "full-access";

export interface ToolCapabilityProfile {
  riskLevel: ToolRiskLevel;
  capabilityTags: string[];
  sandboxExpectation: ToolSandboxExpectation;
  auditCategory: string;
}

export const createToolCapabilityProfile = (
  profile: ToolCapabilityProfile,
): ToolCapabilityProfile => ({
  ...profile,
  capabilityTags: [...profile.capabilityTags],
});

export const getToolRiskLevel = (tool: Pick<AgentTool, "profile">): ToolRiskLevel =>
  tool.profile?.riskLevel ?? "medium";

export const hasToolCapabilityTag = (tool: Pick<AgentTool, "profile">, tag: string): boolean =>
  tool.profile?.capabilityTags.includes(tag) ?? false;

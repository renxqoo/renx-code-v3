import type { PolicyEngine, ResumeAtMode, ResumeAtOptions, TimelineStore } from "../types";

import { isAncestorNode } from "./graph";

export interface ResumeAtRuntimeOptions {
  timeline?: TimelineStore;
  policy?: PolicyEngine;
  timelineMode?: ResumeAtMode;
  timelineParentNodeId?: string;
  disableTimeline?: boolean;
}

export interface ResumeAtPlan {
  mode: ResumeAtMode;
  runtime: ResumeAtRuntimeOptions;
}

export async function buildResumeAtPlan(args: {
  timeline: TimelineStore;
  runId: string;
  targetNodeId: string;
  basePolicy: PolicyEngine;
  options?: ResumeAtOptions;
}): Promise<ResumeAtPlan> {
  const mode: ResumeAtMode = args.options?.mode ?? "fork";
  if (mode === "fast_forward") {
    const head = await args.timeline.load(args.runId);
    if (!head) {
      throw new Error(`Timeline snapshot not found: ${args.runId}`);
    }
    const nodes = await args.timeline.listNodes(args.runId);
    const reachable = isAncestorNode(nodes, args.targetNodeId, head.nodeId);
    if (!reachable) {
      throw new Error(
        `fast_forward requires target node on head lineage: target=${args.targetNodeId}, head=${head.nodeId}`,
      );
    }
  }

  const policy = buildResumePolicy(args.basePolicy, mode, args.options);
  return {
    mode,
    runtime: {
      ...(mode !== "read_only_preview" ? { timeline: args.timeline } : { disableTimeline: true }),
      ...(mode !== "read_only_preview"
        ? { timelineMode: mode, timelineParentNodeId: args.targetNodeId }
        : {}),
      ...(policy ? { policy } : {}),
    },
  };
}

function buildResumePolicy(
  basePolicy: PolicyEngine,
  mode: ResumeAtMode,
  options?: ResumeAtOptions,
): PolicyEngine | undefined {
  const blockIrreversibleByDefault = options?.allowIrreversibleTools !== true;
  const forceReadOnly = mode === "read_only_preview";
  if (!blockIrreversibleByDefault && !forceReadOnly) return undefined;

  return {
    filterTools: async (ctx, tools) => {
      const filtered = await basePolicy.filterTools(ctx, tools);
      return filtered.filter((tool) => tool.isReadOnly?.({}) === true);
    },
    canUseTool: async (ctx, tool, input) => {
      const allowedByBase = await basePolicy.canUseTool(ctx, tool, input);
      if (!allowedByBase) return false;
      return tool.isReadOnly?.(input) === true;
    },
    ...(basePolicy.redactOutput
      ? {
          redactOutput: async (ctx, output) => basePolicy.redactOutput!(ctx, output),
        }
      : {}),
  };
}

import type { Metadata } from "@renx/model";

import type { AgentStatePatch } from "../types";

import type { SkillInvocationRecord, SkillsRuntimeState } from "./types";

export const SKILLS_RUNTIME_STATE_KEY = "__skillsRuntime";

export const createSkillsRuntimeState = (
  snapshot?: Partial<SkillsRuntimeState>,
): SkillsRuntimeState => ({
  invoked: [...(snapshot?.invoked ?? [])],
});

export const getSkillsRuntimeState = (scratchpad: Metadata): SkillsRuntimeState =>
  createSkillsRuntimeState(
    scratchpad[SKILLS_RUNTIME_STATE_KEY] as Partial<SkillsRuntimeState> | undefined,
  );

export const buildSkillsStatePatch = (
  scratchpad: Metadata,
  record: SkillInvocationRecord,
): AgentStatePatch => {
  const current = getSkillsRuntimeState(scratchpad);
  return {
    setScratchpad: {
      [SKILLS_RUNTIME_STATE_KEY]: {
        invoked: [...current.invoked, record],
      },
    },
  };
};

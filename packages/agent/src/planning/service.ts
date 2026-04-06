export type PlanStepStatus = "pending" | "in_progress" | "completed" | "blocked" | "cancelled";

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
  blockedReason?: string;
}

export interface PlanSnapshot {
  goal: string;
  steps: PlanStep[];
  updatedAt: string;
}

export const createPlanSnapshot = (snapshot?: Partial<PlanSnapshot>): PlanSnapshot => ({
  goal: snapshot?.goal ?? "",
  steps: [...(snapshot?.steps ?? [])],
  updatedAt: snapshot?.updatedAt ?? new Date().toISOString(),
});

export class PlanService {
  updateStep(
    snapshot: PlanSnapshot,
    stepId: string,
    patch: Partial<Omit<PlanStep, "id">>,
  ): PlanSnapshot {
    return createPlanSnapshot({
      ...snapshot,
      steps: snapshot.steps.map((step) => (step.id === stepId ? { ...step, ...patch } : step)),
      updatedAt: new Date().toISOString(),
    });
  }
}

import { applyMemoryPolicy, extractScopedMemorySnapshot, hasMeaningfulMemory } from "./policy";
import type {
  MemoryPolicy,
  MemoryScope,
  MemoryScopeResolution,
  MemorySnapshot,
  ResolvedMemorySnapshot,
} from "./types";

export class MemoryWritePipeline {
  constructor(private readonly policy?: Partial<MemoryPolicy>) {}

  plan(
    snapshot: MemorySnapshot | undefined,
    scopes?: MemoryScopeResolution,
  ): {
    runSnapshot: ResolvedMemorySnapshot;
    scopedSnapshots: Partial<Record<MemoryScope, ResolvedMemorySnapshot>>;
  } {
    const runSnapshot = applyMemoryPolicy(snapshot, this.policy);
    const scopedSnapshots: Partial<Record<MemoryScope, ResolvedMemorySnapshot>> = {};

    for (const scope of ["user", "project", "local"] as const) {
      if (!scopes?.[scope]) continue;
      const scopedSnapshot = applyMemoryPolicy(
        extractScopedMemorySnapshot(runSnapshot, scope),
        this.policy,
      );
      if (!hasMeaningfulMemory(scopedSnapshot)) continue;
      scopedSnapshots[scope] = scopedSnapshot;
    }

    return {
      runSnapshot,
      scopedSnapshots,
    };
  }
}

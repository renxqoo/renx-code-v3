import type { AgentState } from "../types";
import type { PreservedContextAsset } from "../context/types";
import {
  applySessionMemoryRecordToState,
  sessionMemoryRecordFromState,
} from "../context/session-memory";

import type {
  MemoryEvent,
  MemoryScopeContext,
  MemoryScopeResolution,
  MemorySnapshot,
  MemorySubsystem,
} from "./types";
import { createMemorySnapshot, mergeMemorySnapshot } from "./snapshot";
import { applyMemoryPolicy } from "./policy";
import {
  buildMemoryAutomationWindow,
  markMemoryAutoSaved,
  shouldAutoSaveMemory,
} from "./automation";
import { applyMemoryGovernance } from "./governance";
import { recallMemoryEntries, type MemoryRecallInput } from "./recall";
import { applyMemoryTenantPolicy } from "./tenant-policy";
import { MemoryWritePipeline } from "./write-pipeline";

const DEFAULT_PROMPT_TOKEN_BUDGET = 4_000;

const estimateTokens = (value: string): number => Math.max(1, Math.ceil(value.length / 4));

const fitToBudget = (sections: string[], budgetTokens: number): string | null => {
  const lines: string[] = [];
  let usedTokens = 0;
  for (const section of sections) {
    const sectionTokens = estimateTokens(section);
    if (usedTokens + sectionTokens > budgetTokens) break;
    lines.push(section);
    usedTokens += sectionTokens;
  }
  if (lines.length === 0) return null;
  return lines.join("\n\n");
};

const collectPreservedContextAssets = (state: AgentState): PreservedContextAsset[] =>
  Object.values(state.context?.preservedContextAssets ?? {}).sort((left, right) => {
    const priorityDiff = (right.priority ?? 0) - (left.priority ?? 0);
    if (priorityDiff !== 0) return priorityDiff;
    return right.updatedAt.localeCompare(left.updatedAt);
  });

export class MemoryService {
  constructor(private readonly subsystem?: MemorySubsystem) {}

  async hydrateState(
    runId: string,
    state: AgentState,
    scopeContext?: MemoryScopeContext,
  ): Promise<AgentState> {
    const scopeSnapshots = await this.loadScopedSnapshots(scopeContext);
    const loaded = this.subsystem ? await this.subsystem.store.load(runId) : null;
    let snapshot = createMemorySnapshot();
    for (const scoped of scopeSnapshots) {
      snapshot = mergeMemorySnapshot(snapshot, scoped);
    }
    snapshot = mergeMemorySnapshot(snapshot, loaded ?? undefined);
    snapshot = mergeMemorySnapshot(snapshot, state.memory);
    snapshot = applyMemoryTenantPolicy(
      snapshot,
      scopeContext ? await this.resolveTenantPolicy(scopeContext) : undefined,
    );
    const withMemory: AgentState = {
      ...state,
      memory: snapshot,
    };
    if (!snapshot.session) return withMemory;
    return applySessionMemoryRecordToState(withMemory, snapshot.session);
  }

  captureState(state: AgentState): MemorySnapshot {
    const base = createMemorySnapshot(state.memory);
    const session = sessionMemoryRecordFromState(state);
    const artifacts = collectPreservedContextAssets(state);
    return createMemorySnapshot({
      ...base,
      ...(session ? { session } : {}),
      artifacts: {
        preservedContextAssets:
          artifacts.length > 0 ? artifacts : (base.artifacts?.preservedContextAssets ?? []),
      },
    });
  }

  async persistState(runId: string, state: AgentState): Promise<void> {
    if (!this.subsystem) return;
    const snapshot = applyMemoryPolicy(this.captureState(state), this.subsystem.policy);
    await this.subsystem.store.save(runId, snapshot);
  }

  async persistStateWithScopes(
    runId: string,
    state: AgentState,
    scopeContext?: MemoryScopeContext,
  ): Promise<void> {
    if (!this.subsystem) return;
    const namespaces = scopeContext ? await this.resolveScopeNamespaces(scopeContext) : undefined;
    const tenantPolicy = scopeContext ? await this.resolveTenantPolicy(scopeContext) : undefined;
    const plan = new MemoryWritePipeline(this.subsystem.policy).plan(
      this.captureState(state),
      namespaces,
    );
    await this.subsystem.store.save(runId, applyMemoryTenantPolicy(plan.runSnapshot, tenantPolicy));
    if (!this.subsystem.scopeStore || !namespaces) return;

    for (const scope of ["user", "project", "local"] as const) {
      const namespace = namespaces[scope];
      if (!namespace) continue;
      const scopedSnapshot = plan.scopedSnapshots[scope];
      if (!scopedSnapshot) continue;
      const existing = await this.subsystem.scopeStore.load(scope, namespace);
      const nextSnapshot = applyMemoryTenantPolicy(
        applyMemoryPolicy(
          mergeMemorySnapshot(existing ?? undefined, scopedSnapshot),
          this.subsystem.policy,
        ),
        tenantPolicy,
      );
      await this.subsystem.scopeStore.save(scope, namespace, nextSnapshot);
    }
  }

  async maybeAutoSave(
    runId: string,
    state: AgentState,
    scopeContext?: MemoryScopeContext,
    options?: { querySource?: string; signal?: AbortSignal },
  ): Promise<AgentState> {
    if (!this.subsystem?.scopeStore || !this.subsystem.extractor || !scopeContext) return state;
    if (!this.isMainThreadQuerySource(options?.querySource)) {
      await this.emit("memory_auto_save_skipped", runId, {
        reason: "non_main_thread",
      });
      return state;
    }

    const autoSave = shouldAutoSaveMemory(state.memory, state.messages, this.subsystem.automation);
    if (!autoSave.shouldAutoSave) {
      await this.emit("memory_auto_save_skipped", runId, {
        reason: autoSave.reason ?? "not_eligible",
      });
      return state;
    }

    const namespaces = await this.resolveScopeNamespaces(scopeContext);
    const tenantPolicy = await this.resolveTenantPolicy(scopeContext);
    const snapshot = createMemorySnapshot(state.memory);
    const conversation = buildMemoryAutomationWindow(state.messages, this.subsystem.automation);
    await this.emit("memory_auto_save_started", runId, {
      conversationMessageCount: conversation.length,
    });

    try {
      const extracted = await this.subsystem.extractor.extract({
        runId,
        conversation,
        snapshot,
        scopeContext,
        namespaces,
        ...(options?.signal ? { signal: options.signal } : {}),
      });

      const timestamp = new Date().toISOString();
      const extractedEntries = createMemorySnapshot(
        applyMemoryTenantPolicy(
          {
            semantic: {
              entries: extracted.entries,
            },
          },
          tenantPolicy,
        ),
      ).semantic.entries;
      let nextState: AgentState = {
        ...state,
        memory: markMemoryAutoSaved(
          mergeMemorySnapshot(snapshot, {
            semantic: {
              entries: extractedEntries,
            },
          }),
          state.messages[state.messages.length - 1]?.id,
          timestamp,
        ),
      };
      nextState = {
        ...nextState,
        memory: applyMemoryGovernance(
          applyMemoryPolicy(nextState.memory, this.subsystem.policy),
          this.subsystem.governance,
        ),
      };
      nextState = {
        ...nextState,
        memory: applyMemoryTenantPolicy(nextState.memory, tenantPolicy),
      };
      await this.subsystem.store.save(runId, nextState.memory);

      const grouped = new Map<"user" | "project" | "local", typeof extracted.entries>();
      for (const entry of extractedEntries) {
        const scope = entry.scope ?? this.subsystem.automation?.targetScope ?? "project";
        const list = grouped.get(scope) ?? [];
        list.push({ ...entry, scope });
        grouped.set(scope, list);
      }

      for (const [scope, entries] of grouped.entries()) {
        const namespace = namespaces[scope];
        if (!namespace || entries.length === 0) continue;
        const existing = await this.subsystem.scopeStore.load(scope, namespace);
        const governed = applyMemoryGovernance(
          applyMemoryPolicy(
            mergeMemorySnapshot(existing ?? undefined, {
              semantic: { entries },
            }),
            this.subsystem.policy,
          ),
          this.subsystem.governance,
        );
        await this.subsystem.scopeStore.save(scope, namespace, governed);
        await this.emit("memory_scope_persisted", runId, {
          scope,
          namespace,
          entryCount: entries.length,
        });
      }

      await this.emit("memory_governed", runId, {
        governanceApplied: this.subsystem.governance !== undefined,
      });
      await this.emit("memory_auto_save_completed", runId, {
        extractedEntryCount: extracted.entries.length,
      });
      return nextState;
    } catch (error) {
      await this.emit("memory_auto_save_failed", runId, {
        message: error instanceof Error ? error.message : "unknown_error",
      });
      return state;
    }
  }

  async loadSnapshot(runId: string): Promise<MemorySnapshot> {
    if (!this.subsystem) return createMemorySnapshot();
    return createMemorySnapshot((await this.subsystem.store.load(runId)) ?? undefined);
  }

  buildPromptMemory(snapshot: MemorySnapshot, recall?: MemoryRecallInput): string | null {
    if (recall?.ignoreMemory) return null;
    const normalized = createMemorySnapshot(snapshot);
    const sections: string[] = [];
    const extraEntries = Object.entries(snapshot).filter(
      ([key]) =>
        key !== "working" && key !== "session" && key !== "semantic" && key !== "artifacts",
    );

    if (normalized.working?.activePlan !== undefined) {
      sections.push(
        `Current Plan:\n${typeof normalized.working.activePlan === "string" ? normalized.working.activePlan : JSON.stringify(normalized.working.activePlan)}`,
      );
    }
    if ((normalized.working?.skills?.length ?? 0) > 0) {
      sections.push(
        `Active Skills:\n${normalized
          .working!.skills!.map((entry) => {
            const path = entry.path ? ` (${entry.path})` : "";
            const content = entry.content ? `\n${entry.content}` : "";
            return `- ${entry.name}${path}${content}`;
          })
          .join("\n\n")}`,
      );
    }
    if ((normalized.working?.rules?.length ?? 0) > 0) {
      sections.push(
        `Active Rules:\n${normalized
          .working!.rules!.map((entry) => {
            const path = entry.path ? ` (${entry.path})` : "";
            const content = entry.content ? `\n${entry.content}` : "";
            return `- ${entry.name}${path}${content}`;
          })
          .join("\n\n")}`,
      );
    }
    const recalledSemanticEntries = recallMemoryEntries(normalized, {
      ...(recall?.query !== undefined ? { query: recall.query } : {}),
      ...(recall?.explicit !== undefined ? { explicit: recall.explicit } : {}),
      ...(recall?.ignoreMemory !== undefined ? { ignoreMemory: recall.ignoreMemory } : {}),
      ...(recall?.limit !== undefined ? { limit: recall.limit } : {}),
    });
    if (recalledSemanticEntries.length > 0) {
      sections.push(
        `Semantic Memory:\n${recalledSemanticEntries
          .map((entry) => {
            const prefix = entry.title ? `${entry.title}: ` : "";
            const why = entry.why ? ` Why: ${entry.why}` : "";
            const how = entry.howToApply ? ` How to apply: ${entry.howToApply}` : "";
            return `- ${prefix}${entry.content}${why}${how}`;
          })
          .join("\n")}`,
      );
    }
    if (extraEntries.length > 0) {
      sections.push(
        `Additional Memory:\n${extraEntries
          .map(
            ([key, value]) =>
              `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
          )
          .join("\n")}`,
      );
    }

    const promptBudget = this.subsystem?.config?.promptTokenBudget ?? DEFAULT_PROMPT_TOKEN_BUDGET;
    return fitToBudget(sections, promptBudget);
  }

  private async loadScopedSnapshots(scopeContext?: MemoryScopeContext): Promise<MemorySnapshot[]> {
    if (!this.subsystem?.scopeStore || !scopeContext) return [];
    const namespaces = await this.resolveScopeNamespaces(scopeContext);
    const snapshots: MemorySnapshot[] = [];
    for (const scope of ["user", "project", "local"] as const) {
      const namespace = namespaces[scope];
      if (!namespace) continue;
      const snapshot = await this.subsystem.scopeStore.load(scope, namespace);
      if (snapshot) snapshots.push(snapshot);
    }
    return snapshots;
  }

  private async resolveScopeNamespaces(
    scopeContext: MemoryScopeContext,
  ): Promise<MemoryScopeResolution> {
    if (this.subsystem?.scopeResolver) {
      return await this.subsystem.scopeResolver(scopeContext);
    }
    const metadata = scopeContext.metadata ?? {};
    return {
      ...(scopeContext.userId
        ? {
            user: scopeContext.tenantId
              ? `${scopeContext.tenantId}:${scopeContext.userId}`
              : scopeContext.userId,
          }
        : {}),
      ...(typeof metadata["projectMemoryKey"] === "string"
        ? { project: metadata["projectMemoryKey"] }
        : typeof metadata["projectId"] === "string"
          ? { project: metadata["projectId"] }
          : typeof metadata["workspaceId"] === "string"
            ? { project: metadata["workspaceId"] }
            : {}),
      ...(typeof metadata["localMemoryKey"] === "string"
        ? { local: metadata["localMemoryKey"] }
        : {}),
    };
  }

  private async resolveTenantPolicy(
    scopeContext: MemoryScopeContext,
  ): Promise<import("./types").MemoryTenantPolicy | undefined> {
    if (!this.subsystem?.tenantPolicyResolver) return undefined;
    return await this.subsystem.tenantPolicyResolver(scopeContext);
  }

  private isMainThreadQuerySource(querySource: string | undefined): boolean {
    return (
      querySource === undefined ||
      querySource === "sdk" ||
      querySource.startsWith("repl_main_thread")
    );
  }

  private async emit(
    type: MemoryEvent["type"],
    runId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.subsystem?.hooks?.onEvent({
      type,
      runId,
      timestamp: new Date().toISOString(),
      payload,
    });
  }
}

import { createMemorySnapshot, mergeMemorySnapshot } from "./snapshot";
import { applyMemoryPolicy } from "./policy";
import { recallMemoryEntries } from "./recall";
import { parseMemoryTaxonomyType } from "./taxonomy";
import type { MemoryPolicy, MemoryScope, MemorySemanticEntry, ScopedMemoryStore } from "./types";

export class MemoryCommandService {
  constructor(
    private readonly store: ScopedMemoryStore,
    private readonly policy?: Partial<MemoryPolicy>,
  ) {}

  async save(input: {
    scope: MemoryScope;
    namespace: string;
    entry: MemorySemanticEntry;
  }): Promise<MemorySemanticEntry> {
    const type = parseMemoryTaxonomyType(input.entry.type);
    if (!type) {
      throw new Error(`Invalid memory taxonomy type: ${String(input.entry.type)}`);
    }
    if (isDerivableSemanticMemory(input.entry)) {
      throw new Error("Memory content is derivable from current repo state");
    }

    const existing = createMemorySnapshot(
      (await this.store.load(input.scope, input.namespace)) ?? undefined,
    );
    const next = applyMemoryPolicy(
      mergeMemorySnapshot(existing, {
        semantic: {
          entries: [
            {
              ...input.entry,
              type,
            },
          ],
        },
      }),
      this.policy,
    );
    await this.store.save(input.scope, input.namespace, next);
    return next.semantic.entries.find((entry) => entry.id === input.entry.id)!;
  }

  async list(input: { scope: MemoryScope; namespace: string }): Promise<MemorySemanticEntry[]> {
    return createMemorySnapshot((await this.store.load(input.scope, input.namespace)) ?? undefined)
      .semantic.entries;
  }

  async delete(input: { scope: MemoryScope; namespace: string; id: string }): Promise<void> {
    const existing = createMemorySnapshot(
      (await this.store.load(input.scope, input.namespace)) ?? undefined,
    );
    const next = createMemorySnapshot({
      ...existing,
      semantic: {
        entries: existing.semantic.entries.filter((entry) => entry.id !== input.id),
      },
    });
    await this.store.save(input.scope, input.namespace, next);
  }

  async recall(input: {
    scope: MemoryScope;
    namespace: string;
    query?: string;
    explicit?: boolean;
    limit?: number;
  }): Promise<MemorySemanticEntry[]> {
    const snapshot = await this.store.load(input.scope, input.namespace);
    return recallMemoryEntries(snapshot ?? undefined, {
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.explicit !== undefined ? { explicit: input.explicit } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
  }
}

const isDerivableSemanticMemory = (entry: MemorySemanticEntry): boolean => {
  const text = `${entry.title ?? ""}\n${entry.description ?? ""}\n${entry.content}`.toLowerCase();
  const derivablePatterns = [
    /\bsrc\/[a-z0-9_./-]+/,
    /\buses typescript\b/,
    /\bfile structure\b/,
    /\brepo has\b/,
    /\bthere is a file\b/,
    /\barchitecture\b/,
  ];
  return derivablePatterns.some((pattern) => pattern.test(text));
};

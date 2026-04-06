import { resolve } from "node:path";

import { discoverSkills } from "./discovery";
import { loadSkillsFromSources } from "./loader";
import type {
  SkillDefinition,
  SkillDiscoveryRequest,
  SkillDiscoveryResult,
  SkillRegistry,
  SkillSourceConfig,
} from "./types";

const normalizeReference = (value: string): string => value.trim().replace(/^\//, "").toLowerCase();

const buildLookupKeys = (skill: SkillDefinition): string[] => {
  const keys = new Set<string>([skill.name.toLowerCase()]);
  for (const alias of skill.aliases) {
    keys.add(alias.toLowerCase());
  }
  const segments = skill.name.split(":");
  if (segments.length > 1) {
    keys.add(segments[segments.length - 1]!.toLowerCase());
  }
  return [...keys];
};

export class InMemorySkillRegistry implements SkillRegistry {
  private readonly skills: SkillDefinition[];
  private readonly lookup = new Map<string, SkillDefinition[]>();

  constructor(skills: SkillDefinition[]) {
    this.skills = [...skills].sort((left, right) => left.name.localeCompare(right.name));
    for (const skill of this.skills) {
      for (const key of buildLookupKeys(skill)) {
        const bucket = this.lookup.get(key) ?? [];
        bucket.push(skill);
        this.lookup.set(key, bucket);
      }
    }
  }

  list(): SkillDefinition[] {
    return [...this.skills];
  }

  resolve(name: string): SkillDefinition | undefined {
    const normalized = normalizeReference(name);
    const exact = this.skills.find((skill) => skill.name.toLowerCase() === normalized);
    if (exact) return exact;
    const alias = this.skills.find((skill) =>
      skill.aliases.some((entry) => entry.toLowerCase() === normalized),
    );
    if (alias) return alias;
    const bucket = this.lookup.get(normalized);
    if (!bucket || bucket.length !== 1) return undefined;
    return bucket[0];
  }

  discover(request: SkillDiscoveryRequest): SkillDiscoveryResult {
    return discoverSkills(this.skills, request);
  }

  version(): string {
    return this.skills.map((skill) => `${skill.name}:${skill.path}`).join("|");
  }
}

export interface CreateFileSkillRegistryOptions {
  sources: Array<string | SkillSourceConfig>;
}

export const createFileSkillRegistry = (options: CreateFileSkillRegistryOptions): SkillRegistry => {
  const sources = options.sources.map((source) =>
    typeof source === "string"
      ? {
          path: resolve(source),
          source: "project" as const,
        }
      : {
          path: resolve(source.path),
          source: source.source ?? "project",
          ...(source.priority !== undefined ? { priority: source.priority } : {}),
        },
  );

  const loaded = loadSkillsFromSources(sources);
  const deduped = new Map<string, { skill: SkillDefinition; priority: number }>();
  for (const entry of loaded) {
    const existing = deduped.get(entry.skill.name);
    if (!existing || entry.priority >= existing.priority) {
      deduped.set(entry.skill.name, entry);
    }
  }
  return new InMemorySkillRegistry([...deduped.values()].map((entry) => entry.skill));
};

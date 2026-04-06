import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { parseSkillMarkdown } from "./frontmatter";
import type { SkillDefinition, SkillSourceConfig } from "./types";

const collectSkillFiles = (sourcePath: string): string[] => {
  const normalized = resolve(sourcePath);
  if (!existsSync(normalized)) return [];
  const stat = statSync(normalized);
  if (stat.isFile()) {
    return basename(normalized).toLowerCase() === "skill.md" ? [normalized] : [];
  }

  const queue = [normalized];
  const files: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
        files.push(fullPath);
      }
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
};

export interface LoadedSkillRecord {
  skill: SkillDefinition;
  priority: number;
}

export const loadSkillsFromSources = (sources: SkillSourceConfig[]): LoadedSkillRecord[] =>
  sources.flatMap((source, index) => {
    const rootPath = resolve(source.path);
    return collectSkillFiles(rootPath).map((filePath) => ({
      skill: parseSkillMarkdown({
        rootPath,
        filePath,
        content: readFileSync(filePath, "utf8"),
        source: source.source ?? "project",
      }),
      priority: source.priority ?? index,
    }));
  });

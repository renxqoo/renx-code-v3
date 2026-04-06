import type { SkillDefinition, SkillDiscoveryRequest, SkillDiscoveryResult } from "./types";

const tokenize = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^a-z0-9:_/-]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const globToRegExp = (value: string): RegExp => {
  const regex = escapeRegExp(value.replaceAll("\\", "/"))
    .replace(/\\\*\\\*/g, ".*")
    .replace(/\\\*/g, "[^/]*");
  return new RegExp(`^${regex}$`, "i");
};

const scoreSkill = (skill: SkillDefinition, request: SkillDiscoveryRequest): number => {
  const query = request.query.trim().toLowerCase();
  const tokens = tokenize(query);
  if (tokens.length === 0) return 0;

  let score = 0;
  const haystacks = [
    skill.name.toLowerCase(),
    skill.description.toLowerCase(),
    ...skill.aliases.map((alias) => alias.toLowerCase()),
    ...skill.tags.map((tag) => tag.toLowerCase()),
    ...skill.keywords.map((keyword) => keyword.toLowerCase()),
  ];

  if (
    skill.name.toLowerCase() === query ||
    skill.aliases.some((alias) => alias.toLowerCase() === query)
  ) {
    score += 100;
  }
  if (skill.name.toLowerCase().includes(query)) score += 40;
  if (skill.description.toLowerCase().includes(query)) score += 20;

  for (const token of tokens) {
    for (const haystack of haystacks) {
      if (haystack.includes(token)) {
        score += haystack === skill.name.toLowerCase() ? 20 : 8;
      }
    }
  }

  if ((request.touchedPaths?.length ?? 0) > 0 && (skill.inputGlobs?.length ?? 0) > 0) {
    const matched = request.touchedPaths!.some((path) =>
      skill.inputGlobs!.some((glob) => globToRegExp(glob).test(path.replaceAll("\\", "/"))),
    );
    if (matched) score += 25;
  }

  return score;
};

export const discoverSkills = (
  skills: SkillDefinition[],
  request: SkillDiscoveryRequest,
): SkillDiscoveryResult => ({
  query: request.query,
  matches: skills
    .map((skill) => ({
      skill,
      score: scoreSkill(skill, request),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.skill.name.localeCompare(right.skill.name);
    })
    .slice(0, request.limit ?? 5)
    .map((entry) => entry.skill),
});

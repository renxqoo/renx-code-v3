import { basename, dirname, extname, relative, resolve, sep } from "node:path";

import type { SkillDefinition, SkillExecutionMode, SkillShell, SkillSource } from "./types";

const parseScalar = (value: string): unknown => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => String(parseScalar(entry)));
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseFrontmatter = (content: string): { data: Record<string, unknown>; body: string } => {
  if (!content.startsWith("---\n")) {
    return { data: {}, body: content.trim() };
  }
  const boundary = content.indexOf("\n---\n", 4);
  if (boundary === -1) {
    return { data: {}, body: content.trim() };
  }
  const rawFrontmatter = content.slice(4, boundary);
  const body = content.slice(boundary + 5).trim();
  const data: Record<string, unknown> = {};
  let currentKey: string | null = null;

  for (const line of rawFrontmatter.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch && currentKey) {
      const existing = data[currentKey];
      const nextValue = String(parseScalar(listMatch[1] ?? ""));
      if (Array.isArray(existing)) {
        existing.push(nextValue);
      } else if (existing === "" || existing === undefined) {
        data[currentKey] = [nextValue];
      } else {
        data[currentKey] = [String(existing), nextValue];
      }
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!keyMatch) continue;
    currentKey = keyMatch[1]!;
    data[currentKey] = parseScalar(keyMatch[2] ?? "");
  }

  return { data, body };
};

const toArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
};

const toOptionalString = (value: unknown): string | undefined => {
  if (value == null) return undefined;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
};

const toExecutionMode = (value: unknown): SkillExecutionMode => {
  const normalized = toOptionalString(value)?.toLowerCase();
  return normalized === "fork" ? "fork" : "inline";
};

const toShell = (value: unknown): SkillShell | undefined => {
  const normalized = toOptionalString(value)?.toLowerCase();
  if (normalized === "bash") return "bash";
  if (normalized === "powershell") return "powershell";
  return undefined;
};

const toBoolean = (value: unknown, defaultValue: boolean): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return defaultValue;
};

const defaultSkillName = (rootPath: string, filePath: string): string => {
  const normalizedRoot = resolve(rootPath);
  const normalizedFile = resolve(filePath);
  const filename = basename(normalizedFile);
  const extensionless =
    filename.toLowerCase() === "skill.md"
      ? basename(dirname(normalizedFile))
      : filename.slice(0, -extname(filename).length);
  const relativeDir = relative(normalizedRoot, dirname(normalizedFile))
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0);

  if (filename.toLowerCase() === "skill.md") {
    return relativeDir.join(":");
  }
  if (relativeDir.length === 0) {
    return extensionless;
  }
  return [...relativeDir, extensionless].join(":");
};

const defaultDescription = (body: string, fallbackName: string): string => {
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ?? `Skill ${fallbackName}`;
};

export const parseSkillMarkdown = (input: {
  rootPath: string;
  filePath: string;
  content: string;
  source: SkillSource;
}): SkillDefinition => {
  const { data, body } = parseFrontmatter(input.content);
  const name = toOptionalString(data["name"]) ?? defaultSkillName(input.rootPath, input.filePath);
  const description = toOptionalString(data["description"]) ?? defaultDescription(body, name);
  const model = toOptionalString(data["model"]);
  const shell = toShell(data["shell"]);
  const tools = toArray(data["allowed-tools"]);
  const disallowedTools = toArray(data["disallowed-tools"]);
  const inputGlobs = toArray(data["paths"]);
  const subagent = toOptionalString(data["subagent"]);

  return {
    name,
    description,
    prompt: body.trim(),
    path: resolve(input.filePath),
    source: input.source,
    tags: toArray(data["tags"]),
    aliases: toArray(data["aliases"]),
    keywords: toArray(data["keywords"]),
    userInvocable: toBoolean(data["user-invocable"], true),
    executionMode: toExecutionMode(data["context"]),
    ...(model ? { model } : {}),
    ...(shell ? { shell } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
    ...(inputGlobs.length > 0 ? { inputGlobs } : {}),
    ...(typeof data["hooks"] === "object" && data["hooks"] !== null
      ? { hooks: data["hooks"] as Record<string, unknown> }
      : {}),
    ...(subagent ? { subagent } : {}),
    metadata: {
      rootPath: resolve(input.rootPath),
      relativePath: relative(resolve(input.rootPath), resolve(input.filePath)).split(sep).join("/"),
    },
  };
};

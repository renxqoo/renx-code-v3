import type { RunMessage } from "../message/types";
import { createMemorySnapshot } from "../memory";
import type { PreservedContextAsset } from "./types";

const toTokenEstimate = (value: string): number => Math.ceil(value.length / 4);

export const buildRehydrationHints = (input: {
  memory: unknown;
  assets?: PreservedContextAsset[];
  rehydrationTokenBudget: number;
  recentFileBudgetTokens: number;
  skillsRehydrateBudgetTokens: number;
  roundIndex?: number;
}): RunMessage[] => {
  return resolveRehydrationPlan(input).messages;
};

export const resolveRehydrationPlan = (input: {
  memory: unknown;
  assets?: PreservedContextAsset[];
  rehydrationTokenBudget: number;
  recentFileBudgetTokens: number;
  skillsRehydrateBudgetTokens: number;
  roundIndex?: number;
}): { messages: RunMessage[]; assetIds: string[] } => {
  let remaining = input.rehydrationTokenBudget;
  const createdAt = new Date().toISOString();
  const hintMessages: RunMessage[] = [];
  const assetIds: string[] = [];
  let sequence = 0;

  const pushHintMessage = (asset: {
    id: string;
    kind: "recent_files" | "plan" | "skills" | "rules" | "hooks" | "mcp" | "custom";
    payload: string;
    budgetLimit?: number;
    allowTruncation?: boolean;
  }): void => {
    const allowed = asset.budgetLimit ?? remaining;
    const fittedPayload = asset.allowTruncation
      ? fitPayloadToBudget(asset.kind, asset.payload, input.rehydrationTokenBudget, allowed)
      : asset.payload;
    const content = `[Post Compact Rehydration:${asset.kind}][budget:${input.rehydrationTokenBudget}]\n${fittedPayload}`;
    const estimate = toTokenEstimate(content);
    if (estimate > remaining || estimate > allowed) return;
    sequence += 1;
    const messageId = `rehydration_${asset.kind}_${Date.now()}_${sequence}`;
    hintMessages.push({
      id: messageId,
      messageId,
      role: "system",
      source: "framework",
      createdAt,
      ...(typeof input.roundIndex === "number" ? { roundIndex: input.roundIndex } : {}),
      content,
      metadata: {
        rehydrationKind: asset.kind,
        preservedContextAssetId: asset.id,
      },
    });
    assetIds.push(asset.id);
    remaining -= estimate;
  };

  const assets = [
    ...normalizeAssetsFromMemory(
      input.memory,
      input.recentFileBudgetTokens,
      input.skillsRehydrateBudgetTokens,
    ),
    ...createMemorySnapshot(
      typeof input.memory === "object" && input.memory !== null
        ? (input.memory as Record<string, unknown>)
        : undefined,
    ).artifacts.preservedContextAssets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      payload: asset.title ? `${asset.title}\n${asset.content}` : asset.content,
      ...(asset.budgetTokens !== undefined ? { budgetLimit: asset.budgetTokens } : {}),
      allowTruncation: asset.allowTruncation ?? false,
      priority: asset.priority ?? 0,
      updatedAt: asset.updatedAt,
    })),
    ...(input.assets ?? []).map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      payload: asset.title ? `${asset.title}\n${asset.content}` : asset.content,
      ...(asset.budgetTokens !== undefined ? { budgetLimit: asset.budgetTokens } : {}),
      allowTruncation: asset.allowTruncation ?? false,
      priority: asset.priority ?? 0,
      updatedAt: asset.updatedAt,
    })),
  ]
    .sort((left, right) => {
      const priorityDiff = (right.priority ?? 0) - (left.priority ?? 0);
      if (priorityDiff !== 0) return priorityDiff;
      return String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
    })
    .filter((asset, index, all) => all.findIndex((entry) => entry.id === asset.id) === index);

  for (const asset of assets) {
    pushHintMessage({
      id: asset.id,
      kind: asset.kind,
      payload: asset.payload,
      ...(asset.budgetLimit !== undefined ? { budgetLimit: asset.budgetLimit } : {}),
      ...(asset.allowTruncation !== undefined ? { allowTruncation: asset.allowTruncation } : {}),
    });
  }

  return { messages: hintMessages, assetIds };
};

const normalizeAssetsFromMemory = (
  memory: unknown,
  recentFileBudgetTokens: number,
  skillsRehydrateBudgetTokens: number,
): Array<{
  id: string;
  kind: "recent_files" | "plan" | "skills" | "rules" | "hooks" | "mcp";
  payload: string;
  budgetLimit?: number;
  allowTruncation?: boolean;
  priority?: number;
  updatedAt: string;
}> => {
  const snapshot = createMemorySnapshot(
    typeof memory === "object" && memory !== null ? (memory as Record<string, unknown>) : undefined,
  );
  const normalized: Array<{
    id: string;
    kind: "recent_files" | "plan" | "skills" | "rules" | "hooks" | "mcp";
    payload: string;
    budgetLimit?: number;
    allowTruncation?: boolean;
    priority?: number;
    updatedAt: string;
  }> = [];
  const updatedAt = new Date().toISOString();

  const recentFilesRaw = snapshot.working?.recentFiles;
  if (recentFilesRaw && recentFilesRaw.length > 0) {
    const serialized = serializeRecentFiles(recentFilesRaw);
    normalized.push({
      id: "memory:recentFiles",
      kind: "recent_files",
      payload: serialized.payload,
      budgetLimit: recentFileBudgetTokens,
      allowTruncation: serialized.allowTruncation,
      priority: 100,
      updatedAt,
    });
  }

  if (snapshot.working?.activePlan !== undefined) {
    normalized.push({
      id: "memory:activePlan",
      kind: "plan",
      payload: `activePlan=${JSON.stringify(snapshot.working.activePlan)}`,
      priority: 90,
      updatedAt,
    });
  }
  if (snapshot.working?.skills && snapshot.working.skills.length > 0) {
    const serialized = serializeSkills(snapshot.working.skills);
    normalized.push({
      id: "memory:skills",
      kind: "skills",
      payload: serialized.payload,
      budgetLimit: skillsRehydrateBudgetTokens,
      allowTruncation: serialized.allowTruncation,
      priority: 80,
      updatedAt,
    });
  }
  if (snapshot.working?.rules && snapshot.working.rules.length > 0) {
    const serialized = serializeRules(snapshot.working.rules);
    normalized.push({
      id: "memory:rules",
      kind: "rules",
      payload: serialized.payload,
      budgetLimit: skillsRehydrateBudgetTokens,
      allowTruncation: serialized.allowTruncation,
      priority: 70,
      updatedAt,
    });
  }
  if (snapshot.working?.hooks !== undefined) {
    normalized.push({
      id: "memory:hooks",
      kind: "hooks",
      payload: `hooks=${JSON.stringify(snapshot.working.hooks)}`,
      priority: 60,
      updatedAt,
    });
  }
  if (snapshot.working?.mcpInstructions !== undefined) {
    normalized.push({
      id: "memory:mcpInstructions",
      kind: "mcp",
      payload: `mcpInstructions=${JSON.stringify(snapshot.working.mcpInstructions)}`,
      priority: 50,
      updatedAt,
    });
  }
  return normalized;
};

const serializeRecentFiles = (
  recentFiles: unknown,
): { payload: string; allowTruncation: boolean } => {
  if (!Array.isArray(recentFiles)) {
    return {
      payload: `recentFiles=${JSON.stringify(recentFiles)}`,
      allowTruncation: false,
    };
  }
  const hasDetailedEntries = recentFiles.some(
    (entry) => entry && typeof entry === "object" && ("content" in entry || "path" in entry),
  );
  if (!hasDetailedEntries) {
    return {
      payload: `recentFiles=${JSON.stringify(recentFiles)}`,
      allowTruncation: false,
    };
  }

  const lines = recentFiles.map((entry) => {
    if (typeof entry === "string") return `- ${entry}`;
    if (!entry || typeof entry !== "object") return `- ${JSON.stringify(entry)}`;
    const path = typeof entry.path === "string" ? entry.path : "<unknown>";
    const content = typeof entry.content === "string" ? `\n${entry.content}` : "";
    return `- ${path}${content}`;
  });
  return {
    payload: `recentFiles:\n${lines.join("\n\n")}`,
    allowTruncation: true,
  };
};

const serializeSkills = (skills: unknown): { payload: string; allowTruncation: boolean } => {
  if (!Array.isArray(skills)) {
    return {
      payload: `skills=${JSON.stringify(skills)}`,
      allowTruncation: false,
    };
  }
  const hasDetailedEntries = skills.some(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      ("content" in entry || "name" in entry || "path" in entry),
  );
  if (!hasDetailedEntries) {
    return {
      payload: `skills=${JSON.stringify(skills)}`,
      allowTruncation: false,
    };
  }

  const lines = skills.map((entry) => {
    if (typeof entry === "string") return `- ${entry}`;
    if (!entry || typeof entry !== "object") return `- ${JSON.stringify(entry)}`;
    const name = typeof entry.name === "string" ? entry.name : "<unknown>";
    const path = typeof entry.path === "string" ? ` (${entry.path})` : "";
    const content = typeof entry.content === "string" ? `\n${entry.content}` : "";
    return `- ${name}${path}${content}`;
  });
  return {
    payload: `skills:\n${lines.join("\n\n")}`,
    allowTruncation: true,
  };
};

const serializeRules = (rules: unknown): { payload: string; allowTruncation: boolean } => {
  if (!Array.isArray(rules)) {
    return {
      payload: `rules=${JSON.stringify(rules)}`,
      allowTruncation: false,
    };
  }

  const lines = rules.map((entry) => {
    if (typeof entry === "string") return entry;
    if (!entry || typeof entry !== "object") return JSON.stringify(entry);
    const name = typeof entry.name === "string" ? entry.name : "<unknown>";
    const content = typeof entry.content === "string" ? entry.content : "";
    return content ? `${name}: ${content}` : name;
  });
  return {
    payload: `rules=${lines.join(" | ")}`,
    allowTruncation: true,
  };
};

const fitPayloadToBudget = (
  kind: string,
  payload: string,
  totalBudgetTokens: number,
  allowedTokens: number,
): string => {
  const prefix = `[Post Compact Rehydration:${kind}][budget:${totalBudgetTokens}]\n`;
  const maxChars = Math.max(24, allowedTokens * 4 - prefix.length);
  if (payload.length <= maxChars) return payload;
  const marker = "\n...[truncated]";
  const keep = Math.max(0, maxChars - marker.length);
  return `${payload.slice(0, keep)}${marker}`;
};

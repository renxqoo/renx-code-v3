import type { AgentStatePatch, ToolContext, ToolResult } from "@renx/agent";

export const PLATFORM_STATE_KEY = "__agentToolsPlatform";

export interface ToolCatalogEntry {
  name: string;
  description?: string;
}

export interface SkillCatalogEntry {
  name: string;
  description?: string;
  path?: string;
}

export interface PlatformTaskRecord {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
  owner?: string;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
  output?: unknown;
  updatedAt: string;
}

export interface PlatformTeamRecord {
  team_name: string;
  description?: string;
  agent_type?: string;
  members: string[];
  updatedAt: string;
}

export interface PlatformScheduleRecord {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  updatedAt: string;
}

export interface PlatformQuestionRecord {
  question: string;
  context?: string;
  askedAt: string;
}

export interface PlatformAgentRecord {
  id: string;
  taskId?: string;
  role: string;
  objective: string;
  status: "running" | "paused" | "completed" | "failed" | "cancelled";
  isolation?: "worktree" | "remote";
  cwd?: string;
  outputFile?: string;
  runInBackground?: boolean;
  parentId?: string;
  reason?: string;
  output?: unknown;
  messages: Array<{
    content: string;
    createdAt: string;
  }>;
  sharedContext: Record<string, unknown>;
  updatedAt: string;
}

export interface PlatformMessageRecord {
  id: string;
  channel: string;
  content: string;
  createdAt: string;
}

export interface PlatformShellCommandRecord {
  id: string;
  command: string;
  cwd: string;
  status: "running" | "completed" | "failed" | "cancelled";
  readOnly: boolean;
  outputFile: string;
  startedAt: string;
  finishedAt?: string;
  description?: string;
  exitCode?: number;
  error?: string;
}

export interface PlatformState {
  planMode: {
    active: boolean;
    reason?: string;
  };
  activeTeam?: string;
  worktree: {
    active: boolean;
    path?: string;
    branch?: string;
  };
  config: Record<string, { scope: string; value: unknown; updatedAt: string }>;
  todos: Array<{ id: string; content: string; status: string }>;
  tasks: Record<string, PlatformTaskRecord>;
  teams: Record<string, PlatformTeamRecord>;
  schedules: Record<string, PlatformScheduleRecord>;
  questions: PlatformQuestionRecord[];
  agents: Record<string, PlatformAgentRecord>;
  messages: PlatformMessageRecord[];
  shellCommands: Record<string, PlatformShellCommandRecord>;
  activatedSkills: string[];
}

export interface McpResourceSummary {
  id: string;
  name: string;
  uri: string;
  mimeType?: string;
}

export interface McpResourceRecord extends McpResourceSummary {
  content: string;
}

export interface McpProvider {
  listResources(server?: string): Promise<Array<McpResourceSummary & { server: string }>>;
  readResource(server: string, uri: string): Promise<McpResourceRecord & { server?: string }>;
  authenticate(server: string): Promise<{
    status: "auth_url" | "unsupported" | "error" | "authenticated";
    message: string;
    authUrl?: string;
  }>;
  callTool(server: string, tool: string, arguments_: unknown): Promise<unknown>;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebSearchRequest {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

export type WebSearchProvider = (request: WebSearchRequest) => Promise<WebSearchResult[]>;

export interface RemoteTriggerRequest {
  action: "list" | "get" | "create" | "update" | "run";
  trigger_id?: string;
  body?: Record<string, unknown>;
}

export type RemoteTriggerProvider = (
  request: RemoteTriggerRequest,
) => Promise<{ status?: number; [key: string]: unknown }>;

export interface LspProvider {
  run(operation: string, input: unknown): Promise<unknown>;
}

export interface PowerShellPolicy {
  denyPatterns?: string[];
}

export interface AgentRunnerRequest {
  id: string;
  role: string;
  objective: string;
  isolation?: "worktree" | "remote";
  cwd?: string;
  runInBackground: boolean;
  parentId?: string;
  sharedContext: Record<string, unknown>;
}

export interface AgentRunnerSyncResult {
  status: "completed" | "failed";
  output?: unknown;
  transcript?: string;
}

export interface AgentRunnerBackgroundResult {
  status: "running" | "completed" | "failed";
  taskId?: string;
  outputFile?: string;
  output?: unknown;
  transcript?: string;
  sharedContext?: Record<string, unknown>;
}

export interface AgentRunnerMutationResult {
  status?: "running" | "paused" | "completed" | "failed";
  output?: unknown;
  transcript?: string;
  outputFile?: string;
  sharedContext?: Record<string, unknown>;
}

export interface AgentRunnerProvider {
  runSync?(request: AgentRunnerRequest): Promise<AgentRunnerSyncResult>;
  launchBackground?(request: AgentRunnerRequest): Promise<AgentRunnerBackgroundResult>;
  getStatus?(agentId: string): Promise<AgentRunnerBackgroundResult | undefined>;
  sendMessage?(
    agentId: string,
    request: { message: string; sharedContext: Record<string, unknown> },
  ): Promise<AgentRunnerMutationResult | undefined>;
  resume?(
    agentId: string,
    request: { sharedContext: Record<string, unknown> },
  ): Promise<AgentRunnerMutationResult | undefined>;
}

export const createPlatformState = (snapshot?: Partial<PlatformState>): PlatformState => ({
  planMode: {
    active: snapshot?.planMode?.active ?? false,
    ...(snapshot?.planMode?.reason ? { reason: snapshot.planMode.reason } : {}),
  },
  ...(snapshot?.activeTeam ? { activeTeam: snapshot.activeTeam } : {}),
  worktree: {
    active: snapshot?.worktree?.active ?? false,
    ...(snapshot?.worktree?.path ? { path: snapshot.worktree.path } : {}),
    ...(snapshot?.worktree?.branch ? { branch: snapshot.worktree.branch } : {}),
  },
  config: { ...(snapshot?.config ?? {}) },
  todos: [...(snapshot?.todos ?? [])],
  tasks: { ...(snapshot?.tasks ?? {}) },
  teams: { ...(snapshot?.teams ?? {}) },
  schedules: { ...(snapshot?.schedules ?? {}) },
  questions: [...(snapshot?.questions ?? [])],
  agents: Object.fromEntries(
    Object.entries(snapshot?.agents ?? {}).map(([id, agent]) => [
      id,
      {
        ...agent,
        status: agent.status,
        ...(agent.taskId ? { taskId: agent.taskId } : {}),
        messages: [...(agent.messages ?? [])],
        sharedContext: { ...(agent.sharedContext ?? {}) },
        ...(agent.isolation ? { isolation: agent.isolation } : {}),
        ...(agent.cwd ? { cwd: agent.cwd } : {}),
        ...(agent.outputFile ? { outputFile: agent.outputFile } : {}),
        ...(agent.runInBackground !== undefined ? { runInBackground: agent.runInBackground } : {}),
      },
    ]),
  ),
  messages: [...(snapshot?.messages ?? [])],
  shellCommands: { ...(snapshot?.shellCommands ?? {}) },
  activatedSkills: [...(snapshot?.activatedSkills ?? [])],
});

export const getPlatformState = (ctx: ToolContext): PlatformState =>
  createPlatformState(
    ctx.runContext.state.scratchpad[PLATFORM_STATE_KEY] as Partial<PlatformState> | undefined,
  );

export const buildPlatformPatch = (
  ctx: ToolContext,
  updater: (state: PlatformState) => PlatformState,
): AgentStatePatch => ({
  setScratchpad: {
    [PLATFORM_STATE_KEY]: updater(getPlatformState(ctx)),
  },
});

export const mutatePlatformStateInPlace = (
  ctx: ToolContext,
  updater: (state: PlatformState) => PlatformState,
): void => {
  ctx.runContext.state.scratchpad[PLATFORM_STATE_KEY] = updater(getPlatformState(ctx));
};

export const nowIso = (): string => new Date().toISOString();

export const okToolResult = (
  content: string,
  options?: {
    structured?: unknown;
    statePatch?: AgentStatePatch;
    metadata?: Record<string, unknown>;
  },
): ToolResult => ({
  content,
  ...(options?.structured !== undefined ? { structured: options.structured } : {}),
  ...(options?.statePatch ? { statePatch: options.statePatch } : {}),
  ...(options?.metadata ? { metadata: options.metadata } : {}),
});

export const getToolCatalog = (ctx: ToolContext): ToolCatalogEntry[] => {
  const raw = ctx.runContext.metadata["toolCatalog"];
  return Array.isArray(raw) ? (raw as ToolCatalogEntry[]) : [];
};

export const getSkillsCatalog = (ctx: ToolContext): SkillCatalogEntry[] => {
  const raw = ctx.runContext.metadata["skillsCatalog"];
  return Array.isArray(raw) ? (raw as SkillCatalogEntry[]) : [];
};

export const getMcpProvider = (ctx: ToolContext): McpProvider | undefined =>
  ctx.runContext.metadata["mcpProvider"] as McpProvider | undefined;

export const getWebSearchProvider = (ctx: ToolContext): WebSearchProvider | undefined =>
  ctx.runContext.metadata["webSearchProvider"] as WebSearchProvider | undefined;

export const getRemoteTriggerProvider = (ctx: ToolContext): RemoteTriggerProvider | undefined =>
  ctx.runContext.metadata["remoteTriggerProvider"] as RemoteTriggerProvider | undefined;

export const getLspProvider = (ctx: ToolContext): LspProvider | undefined =>
  ctx.runContext.metadata["lspProvider"] as LspProvider | undefined;

export const getPowerShellPolicy = (ctx: ToolContext): PowerShellPolicy | undefined =>
  ctx.runContext.metadata["powershellPolicy"] as PowerShellPolicy | undefined;

export const getAgentRunnerProvider = (ctx: ToolContext): AgentRunnerProvider | undefined =>
  ctx.runContext.metadata["agentRunnerProvider"] as AgentRunnerProvider | undefined;

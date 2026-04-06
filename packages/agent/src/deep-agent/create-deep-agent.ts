import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { getDefaultModelClient, type ModelBinding } from "@renx/model";

import { RuleBasedApprovalEngine, InMemoryApprovalDecisionStore } from "../approval/rule-based";
import { AgentBase } from "../base";
import { initialContextRuntimeState } from "../context";
import type { ContextManagerConfig } from "../context/types";
import { AgentError } from "../errors";
import { generateId } from "../helpers";
import { mergeMemorySnapshot, type MemorySnapshot, type MemorySubsystem } from "../memory";
import type { AgentMiddleware } from "../middleware/types";
import type { RuntimeConfig } from "../runtime/config";
import { createFileSkillRegistry, type SkillsSubsystem } from "../skills";
import { InMemoryTimelineStore } from "../timeline";
import type {
  AgentCompactOptions,
  AgentCompactResult,
  AgentIdentity,
  AgentInput,
  AgentResult,
  AgentRunContext,
  AgentServices,
  AgentState,
  AgentResumeSnapshot,
  AgentStreamEvent,
  ApprovalEngine,
  AuditLogger,
  ContextLifecycleHooks,
  Metadata,
  ResumeAtOptions,
  SessionMemoryRecord,
  SessionMemorySubsystem,
  TimelineStore,
} from "../types";
import type { AgentTool, BackendResolver, ExecutionBackend } from "../tool/types";

import { buildResponseFormatPrompt, createStructuredOutputTool } from "./response-format";
import { createTaskTool, TASK_SYSTEM_PROMPT } from "./subagents";
import type {
  CreateDeepAgentOptions,
  DeepAgentBackend,
  DeepAgentBackendFactory,
  DeepAgentBackendIntegration,
  DeepAgentBackendSource,
  DeepAgentHandle,
  DeepAgentInlineSubagent,
  DeepAgentInvocationOptions,
  DeepAgentSubagent,
} from "./types";

const BASE_DEEP_AGENT_PROMPT = [
  "You are a Deep Agent, an AI assistant that helps users accomplish tasks using tools.",
  "Be concise, accurate, and action-oriented.",
  "Read relevant context before acting, then implement, verify, and continue until the task is complete or genuinely blocked.",
].join("\n");

interface ResolvedBackend {
  resolver?: BackendResolver;
  middleware: AgentMiddleware[];
}

interface ResolvedDeepAgentConfig {
  name: string;
  model: ModelBinding;
  systemPrompt: NonNullable<CreateDeepAgentOptions["systemPrompt"]>;
  directTools: AgentTool[];
  middlewares: AgentMiddleware[];
  policy?: RuntimeConfig["policy"];
  maxSteps: number;
  timeline: TimelineStore;
  audit?: AuditLogger;
  approval?: ApprovalEngine;
  memory?: MemorySubsystem;
  sessionMemory?: SessionMemorySubsystem;
  skillsSubsystem?: SkillsSubsystem;
  backendResolver?: BackendResolver;
  backendSource?: DeepAgentBackend;
  store?: unknown;
  context?: Partial<ContextManagerConfig>;
  contextSchema?: CreateDeepAgentOptions["contextSchema"];
  retry?: RuntimeConfig["retry"];
  contextLifecycleHooks?: ContextLifecycleHooks;
  identity: AgentIdentity;
  metadata: Metadata;
  initializeRunContext?: CreateDeepAgentOptions["initializeRunContext"];
  initialMemory: MemorySnapshot;
  subagents: DeepAgentSubagent[];
  responseFormat?: CreateDeepAgentOptions["responseFormat"];
}

const isBackendResolver = (value: unknown): value is BackendResolver =>
  !!value && typeof value === "object" && typeof (value as BackendResolver).resolve === "function";

const isExecutionBackend = (value: unknown): value is ExecutionBackend =>
  !!value &&
  typeof value === "object" &&
  typeof (value as ExecutionBackend).kind === "string" &&
  typeof (value as ExecutionBackend).capabilities === "function";

const isBackendFactory = (value: unknown): value is DeepAgentBackendFactory =>
  typeof value === "function";

const isBackendIntegration = (value: unknown): value is DeepAgentBackendIntegration =>
  !!value && typeof value === "object" && "backend" in (value as Record<string, unknown>);

const isInlineSubagent = (value: DeepAgentSubagent): value is DeepAgentInlineSubagent =>
  "systemPrompt" in value;

const createStaticBackendResolver = (backend: ExecutionBackend): BackendResolver => ({
  resolve: () => backend,
});

const createFactoryBackendResolver = (
  factory: DeepAgentBackendFactory,
  store: unknown,
): BackendResolver => ({
  resolve: async (ctx) =>
    await factory({
      state: ctx.state,
      ...(store !== undefined ? { store } : {}),
    }),
});

const resolveBackendSource = (
  backend: DeepAgentBackendSource | undefined,
  store: unknown,
): BackendResolver | undefined => {
  if (!backend) return undefined;
  if (isBackendResolver(backend)) return backend;
  if (isExecutionBackend(backend)) return createStaticBackendResolver(backend);
  if (isBackendFactory(backend)) return createFactoryBackendResolver(backend, store);
  return undefined;
};

const resolveBackend = (backend: DeepAgentBackend | undefined, store: unknown): ResolvedBackend => {
  if (!backend) {
    return { middleware: [] };
  }
  if (isBackendIntegration(backend)) {
    const resolver = resolveBackendSource(backend.backend, store);
    return {
      middleware: backend.middleware ?? [],
      ...(resolver ? { resolver } : {}),
    };
  }
  const resolver = resolveBackendSource(backend, store);
  return {
    middleware: [],
    ...(resolver ? { resolver } : {}),
  };
};

const joinPromptSections = (sections: Array<string | undefined>): string =>
  sections
    .filter((section): section is string => !!section && section.trim().length > 0)
    .join("\n\n");

const combineSystemPrompt = (
  systemPrompt: CreateDeepAgentOptions["systemPrompt"],
  extras: string[],
): NonNullable<CreateDeepAgentOptions["systemPrompt"]> => {
  if (!systemPrompt) {
    return joinPromptSections([...extras, BASE_DEEP_AGENT_PROMPT]);
  }
  if (typeof systemPrompt === "string") {
    return joinPromptSections([systemPrompt, ...extras, BASE_DEEP_AGENT_PROMPT]);
  }
  return async (ctx) => {
    const resolved = await systemPrompt(ctx);
    return joinPromptSections([resolved, ...extras, BASE_DEEP_AGENT_PROMPT]);
  };
};

const toNamedEntry = (path: string, content: string) => ({
  name: basename(path),
  path,
  content,
  updatedAt: new Date().toISOString(),
  scope: "project" as const,
});

const normalizeSourcePath = (value: string): string => resolve(value);

const loadFileIfPresent = (path: string): string | null => {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  if (!stat.isFile()) return null;
  return readFileSync(path, "utf8");
};

const collectSkillFiles = (source: string): string[] => {
  const normalized = normalizeSourcePath(source);
  if (!existsSync(normalized)) return [];
  const stat = statSync(normalized);
  if (stat.isFile()) {
    return basename(normalized).toLowerCase() === "skill.md" ? [normalized] : [];
  }

  const result: string[] = [];
  const queue = [normalized];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
        result.push(fullPath);
      }
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
};

const loadMemorySources = (sources: string[] | undefined): MemorySnapshot => {
  if (!sources || sources.length === 0) return {};
  return {
    working: {
      rules: sources
        .map((source) => normalizeSourcePath(source))
        .flatMap((source) => {
          if (!existsSync(source)) return [];
          const stat = statSync(source);
          if (stat.isDirectory()) {
            const agentsPath = join(source, "AGENTS.md");
            const content = loadFileIfPresent(agentsPath);
            return content ? [toNamedEntry(agentsPath, content)] : [];
          }
          const content = loadFileIfPresent(source);
          return content ? [toNamedEntry(source, content)] : [];
        }),
    },
  };
};

const loadSkillSources = (sources: string[] | undefined): MemorySnapshot => {
  if (!sources || sources.length === 0) return {};
  const entries = sources
    .flatMap((source) => collectSkillFiles(source))
    .map((path) => ({
      name: basename(dirname(path)),
      path,
      content: readFileSync(path, "utf8"),
      updatedAt: new Date().toISOString(),
      scope: "project" as const,
    }));
  if (entries.length === 0) return {};
  return {
    working: {
      skills: entries,
    },
  };
};

const createApprovalFromInterruptOn = (
  interruptOn: CreateDeepAgentOptions["interruptOn"],
  approval: ApprovalEngine | undefined,
): ApprovalEngine | undefined => {
  if (approval) return approval;
  if (!interruptOn || Object.keys(interruptOn).length === 0) return undefined;
  const store = new InMemoryApprovalDecisionStore();
  const rules = Object.entries(interruptOn).flatMap(([toolName, value], index) => {
    if (value === false) return [];
    const config = value === true ? undefined : value;
    return [
      {
        id: `interrupt_${index}_${toolName}`,
        match: {
          toolNames: [toolName],
        },
        requireApproval: true,
        approverScope: config?.approverScope ?? "user",
        reason: config?.reason ?? `Tool "${toolName}" requires approval`,
      },
    ];
  });
  return new RuleBasedApprovalEngine(store, rules);
};

const resolveTimeline = (options: CreateDeepAgentOptions): TimelineStore => {
  if (options.timeline) return options.timeline;
  if (options.checkpointer && options.checkpointer !== true) return options.checkpointer;
  return new InMemoryTimelineStore();
};

const resolveModelBinding = (model: CreateDeepAgentOptions["model"]): ModelBinding => {
  if (typeof model !== "string") {
    return model;
  }
  const client = getDefaultModelClient();
  if (!client) {
    throw new Error(`Default model client is required to use string model "${model}"`);
  }
  return {
    client,
    name: model,
  };
};

const resolveSkillsSubsystem = (
  explicit: SkillsSubsystem | undefined,
  sources: string[] | undefined,
): SkillsSubsystem | undefined => {
  if (explicit) return explicit;
  if (!sources || sources.length === 0) return undefined;
  return {
    registry: createFileSkillRegistry({
      sources,
    }),
  };
};

const resolveConfig = (options: CreateDeepAgentOptions): ResolvedDeepAgentConfig => {
  const backend = resolveBackend(options.backend, options.store);
  const timeline = resolveTimeline(options);
  const approval = createApprovalFromInterruptOn(options.interruptOn, options.approval);
  const skillsSubsystem = resolveSkillsSubsystem(options.skillsSubsystem, options.skills);
  const initialMemory = mergeMemorySnapshot(
    mergeMemorySnapshot(loadMemorySources(options.memory), loadSkillSources(options.skills)),
    options.workingMemory,
  );
  const extras: string[] = [];
  if ((options.subagents?.length ?? 0) > 0) {
    extras.push(TASK_SYSTEM_PROMPT);
  }
  if (options.responseFormat) {
    extras.push(buildResponseFormatPrompt());
  }

  return {
    name: options.name ?? "deep-agent",
    model: resolveModelBinding(options.model),
    systemPrompt: combineSystemPrompt(options.systemPrompt, extras),
    directTools: options.tools ?? [],
    middlewares: [...backend.middleware, ...(options.middleware ?? [])],
    maxSteps: options.maxSteps ?? 100000,
    timeline,
    ...(options.audit ? { audit: options.audit } : {}),
    ...(approval ? { approval } : {}),
    ...(options.memorySubsystem ? { memory: options.memorySubsystem } : {}),
    ...(options.sessionMemory ? { sessionMemory: options.sessionMemory } : {}),
    ...(skillsSubsystem ? { skillsSubsystem } : {}),
    ...(backend.resolver ? { backendResolver: backend.resolver } : {}),
    ...(options.backend ? { backendSource: options.backend } : {}),
    ...(options.store !== undefined ? { store: options.store } : {}),
    ...(options.context ? { context: options.context } : {}),
    ...(options.contextSchema ? { contextSchema: options.contextSchema } : {}),
    ...(options.retry ? { retry: options.retry } : {}),
    ...(options.contextLifecycleHooks
      ? { contextLifecycleHooks: options.contextLifecycleHooks }
      : {}),
    identity: options.identity ?? {
      userId: "unknown",
      tenantId: "default",
      roles: [],
    },
    metadata: options.metadata ?? {},
    ...(options.initializeRunContext ? { initializeRunContext: options.initializeRunContext } : {}),
    initialMemory,
    subagents: options.subagents ?? [],
    ...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
  };
};

class ConfiguredDeepAgent extends AgentBase implements DeepAgentHandle {
  private readonly subagentHandles = new Map<string, DeepAgentHandle>();
  private readonly structuredOutputTool: AgentTool | undefined;
  private readonly taskTool: AgentTool | undefined;

  constructor(private readonly config: ResolvedDeepAgentConfig) {
    super();
    this.structuredOutputTool = this.config.responseFormat
      ? createStructuredOutputTool(this.config.responseFormat)
      : undefined;
    this.taskTool =
      this.config.subagents.length > 0
        ? createTaskTool({
            subagents: this.config.subagents,
            resolveRunnable: (subagent) => this.resolveSubagentHandle(subagent),
          })
        : undefined;
  }

  async invoke(input: AgentInput, options?: DeepAgentInvocationOptions): Promise<AgentResult> {
    const normalizedInput = this.validateInput(input);
    return await super.invoke(normalizedInput, this.toRunOverrides(options));
  }

  async *stream(
    input: AgentInput,
    options?: DeepAgentInvocationOptions,
  ): AsyncGenerator<AgentStreamEvent, AgentResult> {
    const normalizedInput = this.validateInput(input);
    return yield* super.stream(normalizedInput, this.toRunOverrides(options));
  }

  protected getName(): string {
    return this.config.name;
  }

  protected getSystemPrompt(ctx: AgentRunContext): string | Promise<string> {
    return typeof this.config.systemPrompt === "function"
      ? this.config.systemPrompt(ctx)
      : this.config.systemPrompt;
  }

  protected getTools(): AgentTool[] {
    return [
      ...this.config.directTools,
      ...(this.taskTool ? [this.taskTool] : []),
      ...(this.structuredOutputTool ? [this.structuredOutputTool] : []),
    ];
  }

  protected getModelClient() {
    return this.config.model.client;
  }

  protected getModelName(): string {
    return this.config.model.name;
  }

  protected getMiddlewares(): AgentMiddleware[] {
    return this.config.middlewares;
  }

  protected getMaxSteps(): number {
    return this.config.maxSteps;
  }

  protected getTimelineStore(): TimelineStore | undefined {
    return this.config.timeline;
  }

  protected getAuditLogger(): AuditLogger | undefined {
    return this.config.audit;
  }

  protected getApprovalEngine(): ApprovalEngine | undefined {
    return this.config.approval;
  }

  protected getMemory(): MemorySubsystem | undefined {
    return this.config.memory;
  }

  protected getSessionMemory(): SessionMemorySubsystem | undefined {
    return this.config.sessionMemory;
  }

  protected getBackendResolver(): BackendResolver | undefined {
    return this.config.backendResolver;
  }

  protected getContextConfig(): Partial<ContextManagerConfig> | undefined {
    return this.config.context;
  }

  protected getRetryConfig(): RuntimeConfig["retry"] | undefined {
    return this.config.retry;
  }

  protected getContextLifecycleHooks(): ContextLifecycleHooks | undefined {
    return this.config.contextLifecycleHooks;
  }

  protected getIdentity(): AgentIdentity {
    return this.config.identity;
  }

  protected override async createRunContext(input: AgentInput): Promise<AgentRunContext> {
    const state: AgentState = {
      runId: generateId("run"),
      messages: [],
      scratchpad: {},
      memory: mergeMemorySnapshot({}, this.config.initialMemory),
      context: initialContextRuntimeState(),
      stepCount: 0,
      status: "running",
    };
    const services: AgentServices = {
      timeline: this.config.timeline,
      ...(this.config.audit ? { audit: this.config.audit } : {}),
      ...(this.config.approval ? { approvalEngine: this.config.approval } : {}),
      ...(this.config.memory ? { memory: this.config.memory } : {}),
      ...(this.config.skillsSubsystem ? { skills: this.config.skillsSubsystem } : {}),
    };
    const sessionMemory = this.config.memory?.session ?? this.config.sessionMemory;
    if (sessionMemory) {
      services.sessionMemory = sessionMemory;
    }

    let ctx: AgentRunContext = {
      input: {
        ...input,
        ...(input.metadata || Object.keys(this.config.metadata).length > 0
          ? {
              metadata: {
                ...this.config.metadata,
                ...(input.metadata ?? {}),
              },
            }
          : {}),
      },
      identity: this.config.identity,
      state,
      services,
      metadata: {
        ...this.config.metadata,
        ...(input.metadata ?? {}),
      },
    };
    if (this.config.initializeRunContext) {
      ctx = await this.config.initializeRunContext(ctx, input);
    }
    return ctx;
  }

  private validateInput(input: AgentInput): AgentInput {
    const schema = this.config.contextSchema;
    if (!schema) return input;
    const parsed = schema.safeParse(input.context);
    if (parsed.success) {
      return {
        ...input,
        context: parsed.data,
      };
    }
    throw new AgentError({
      code: "VALIDATION_ERROR",
      message: `Input context failed validation: ${parsed.error.message}`,
      cause: parsed.error,
    });
  }

  private toRunOverrides(
    options: DeepAgentInvocationOptions | undefined,
  ): { maxSteps?: number } | undefined {
    const maxSteps = options?.recursionLimit ?? options?.maxSteps;
    if (maxSteps === undefined) return undefined;
    return {
      maxSteps,
    };
  }

  private resolveSubagentHandle(subagent: DeepAgentSubagent): DeepAgentHandle {
    const cached = this.subagentHandles.get(subagent.name);
    if (cached) return cached;
    if (!isInlineSubagent(subagent)) {
      this.subagentHandles.set(subagent.name, subagent.runnable);
      return subagent.runnable;
    }

    const handle = createDeepAgent({
      name: subagent.name,
      model: subagent.model ?? this.config.model,
      systemPrompt: subagent.systemPrompt,
      tools: subagent.tools ?? this.config.directTools,
      ...(subagent.maxSteps !== undefined ? { maxSteps: subagent.maxSteps } : {}),
      ...(subagent.middleware ? { middleware: subagent.middleware } : {}),
      ...(subagent.interruptOn ? { interruptOn: subagent.interruptOn } : {}),
      ...(subagent.memory ? { memory: subagent.memory } : {}),
      ...(subagent.skills ? { skills: subagent.skills } : {}),
      ...(subagent.responseFormat ? { responseFormat: subagent.responseFormat } : {}),
      ...(this.config.backendSource ? { backend: this.config.backendSource } : {}),
      ...(this.config.store !== undefined ? { store: this.config.store } : {}),
      ...(this.config.context ? { context: this.config.context } : {}),
      ...(this.config.retry ? { retry: this.config.retry } : {}),
      ...(this.config.memory ? { memorySubsystem: this.config.memory } : {}),
      ...(!subagent.skills && this.config.skillsSubsystem
        ? { skillsSubsystem: this.config.skillsSubsystem }
        : {}),
      ...(this.config.sessionMemory ? { sessionMemory: this.config.sessionMemory } : {}),
      identity: this.config.identity,
      metadata: this.config.metadata,
    });
    this.subagentHandles.set(subagent.name, handle);
    return handle;
  }
}

export const createDeepAgent = (options: CreateDeepAgentOptions): DeepAgentHandle =>
  new ConfiguredDeepAgent(resolveConfig(options));

// src/errors.ts
var AgentError = class extends Error {
  name = "AgentError";
  code;
  cause;
  retryable;
  metadata;
  constructor(init) {
    super(init.message);
    this.code = init.code;
    if (init.cause !== void 0) {
      this.cause = init.cause;
    }
    this.retryable = init.retryable ?? false;
    if (init.metadata !== void 0) {
      this.metadata = init.metadata;
    }
  }
};

// src/helpers.ts
var isTerminalStatus = (status) => status === "completed" || status === "failed";
var shouldPause = (status) => status === "waiting_approval" || status === "interrupted";

// src/state.ts
var applyStatePatch = (state, patch) => {
  if (!patch) return state;
  return {
    ...state,
    ...patch.appendMessages ? { messages: [...state.messages, ...patch.appendMessages] } : {},
    ...patch.setScratchpad ? { scratchpad: { ...state.scratchpad, ...patch.setScratchpad } } : {},
    ...patch.mergeMemory ? { memory: { ...state.memory, ...patch.mergeMemory } } : {},
    ...patch.setStatus ? { status: patch.setStatus } : {},
    ...patch.setError ? { error: patch.setError } : {}
  };
};

// src/message/reducer.ts
var applyMessagePatch = (state, patch) => {
  if (patch.replaceMessages) {
    return { ...state, messages: patch.replaceMessages };
  }
  if (patch.appendMessages?.length) {
    return { ...state, messages: [...state.messages, ...patch.appendMessages] };
  }
  return state;
};
var appendMessages = (messages) => ({
  appendMessages: messages
});
var replaceMessages = (messages) => ({
  replaceMessages: messages
});

// src/message/validator.ts
var VALID_ROLES = /* @__PURE__ */ new Set(["system", "user", "assistant", "tool"]);
var validateMessageSequence = (messages) => {
  const issues = [];
  const seenIds = /* @__PURE__ */ new Set();
  const allToolCallIds = /* @__PURE__ */ new Set();
  const answeredToolCallIds = /* @__PURE__ */ new Set();
  for (const msg of messages) {
    if (seenIds.has(msg.id)) {
      issues.push({
        code: "DUPLICATE_MESSAGE_ID",
        message: `Duplicate message id: ${msg.id}`,
        messageId: msg.id
      });
    }
    seenIds.add(msg.id);
    if (!VALID_ROLES.has(msg.role)) {
      issues.push({
        code: "INVALID_ROLE",
        message: `Invalid role: ${msg.role}`,
        messageId: msg.id
      });
    }
    if (msg.role === "assistant" && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        allToolCallIds.add(tc.id);
      }
    }
    if (msg.role === "tool") {
      if (!msg.toolCallId) {
        issues.push({
          code: "MISSING_TOOL_CALL_ID",
          message: `Tool message missing toolCallId: ${msg.id}`,
          messageId: msg.id
        });
      } else {
        answeredToolCallIds.add(msg.toolCallId);
      }
    }
  }
  for (const tcId of allToolCallIds) {
    if (!answeredToolCallIds.has(tcId)) {
      issues.push({
        code: "DANGLING_TOOL_CALL",
        message: `Tool call ${tcId} has no matching tool result`,
        toolCallId: tcId
      });
    }
  }
  for (const tcId of answeredToolCallIds) {
    if (!allToolCallIds.has(tcId)) {
      issues.push({
        code: "ORPHAN_TOOL_RESULT",
        message: `Tool result references unknown tool call: ${tcId}`,
        toolCallId: tcId
      });
    }
  }
  return {
    valid: issues.length === 0,
    issues
  };
};

// src/message/patch-tool-pairs.ts
var patchToolPairs = (messages) => {
  const requestedToolCalls = /* @__PURE__ */ new Map();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        requestedToolCalls.set(tc.id, { toolName: tc.name, messageIndex: i });
      }
    }
  }
  const answeredToolCallIds = /* @__PURE__ */ new Set();
  for (const msg of messages) {
    if (msg.role === "tool" && msg.toolCallId) {
      answeredToolCallIds.add(msg.toolCallId);
    }
  }
  const missingIds = [];
  for (const tcId of requestedToolCalls.keys()) {
    if (!answeredToolCallIds.has(tcId)) {
      missingIds.push(tcId);
    }
  }
  if (missingIds.length === 0) {
    return { messages, patched: false, patchedToolCallIds: [] };
  }
  const assistantToolCallsByMessage = /* @__PURE__ */ new Map();
  for (const [tcId, info] of requestedToolCalls) {
    if (missingIds.includes(tcId)) {
      const existing = assistantToolCallsByMessage.get(info.messageIndex) ?? [];
      existing.push({ id: tcId, name: info.toolName, input: void 0 });
      assistantToolCallsByMessage.set(info.messageIndex, existing);
    }
  }
  const patched = [];
  for (let i = 0; i < messages.length; i++) {
    patched.push(messages[i]);
    const missingForThis = assistantToolCallsByMessage.get(i);
    if (missingForThis) {
      for (const tc of missingForThis) {
        patched.push(createSyntheticToolMessage(tc.id, tc.name));
      }
    }
  }
  return {
    messages: patched,
    patched: true,
    patchedToolCallIds: missingIds
  };
};
var createSyntheticToolMessage = (toolCallId, toolName) => ({
  id: `patch_${toolCallId}`,
  role: "tool",
  name: toolName,
  toolCallId,
  content: "[Synthetic tool result: missing, interrupted, or rejected]",
  createdAt: (/* @__PURE__ */ new Date()).toISOString(),
  metadata: {
    synthetic: true,
    patchReason: "missing_tool_result"
  }
});

// src/message/manager.ts
var DefaultMessageManager = class {
  historyWindowOptions;
  constructor(options) {
    this.historyWindowOptions = {
      maxRecentMessages: options?.maxRecentMessages ?? 30
    };
  }
  normalizeIncoming(input) {
    if (input.messages?.length) {
      return input.messages.map((m) => this.normalizeMessage(m));
    }
    if (input.inputText) {
      return [this.createUserMessage(input.inputText)];
    }
    return [];
  }
  appendUserMessage(state, text) {
    return applyMessagePatch(state, { appendMessages: [this.createUserMessage(text)] });
  }
  appendAssistantMessage(state, content) {
    return applyMessagePatch(state, { appendMessages: [this.createAssistantMessage(content)] });
  }
  appendAssistantToolCallMessage(state, content, toolCalls) {
    return applyMessagePatch(state, {
      appendMessages: [
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content,
          createdAt: (/* @__PURE__ */ new Date()).toISOString(),
          toolCalls
        }
      ]
    });
  }
  appendToolResultMessage(state, toolName, toolCallId, content) {
    return applyMessagePatch(state, {
      appendMessages: [
        {
          id: crypto.randomUUID(),
          role: "tool",
          name: toolName,
          toolCallId,
          content,
          createdAt: (/* @__PURE__ */ new Date()).toISOString()
        }
      ]
    });
  }
  validate(messages) {
    return validateMessageSequence(messages);
  }
  patchToolPairs(messages) {
    return patchToolPairs(messages);
  }
  /**
   * Build effective messages from the canonical message history.
   *
   * Pipeline:
   * 1. validate — check for structural issues
   * 2. patchToolPairs — fix incomplete tool call/result pairs
   * 3. applyHistoryWindow — trim to recent messages
   * 4. injectMemoryMessages — prepend memory as system context
   */
  buildEffectiveMessages(ctx) {
    let messages = [...ctx.state.messages];
    const validation = this.validate(messages);
    const patched = this.patchToolPairs(messages);
    messages = patched.messages;
    if (!validation.valid) {
    }
    messages = this.applyHistoryWindow(messages, this.historyWindowOptions);
    messages = this.injectMemoryMessages(messages, ctx.state.memory);
    return messages;
  }
  // --- Pipeline steps ---
  /**
   * Apply history windowing — keep only the most recent N messages.
   * Older messages beyond the window are dropped.
   */
  applyHistoryWindow(messages, options) {
    const max = options.maxRecentMessages ?? 30;
    if (messages.length <= max) return messages;
    return messages.slice(messages.length - max);
  }
  /**
   * Inject memory as a system-like context message at the head.
   * Memory messages are temporary — they do not pollute state.messages.
   */
  injectMemoryMessages(messages, memory) {
    const keys = Object.keys(memory);
    if (keys.length === 0) return messages;
    const memoryContent = JSON.stringify(memory, null, 2);
    const memoryMessage = {
      id: "__memory_injection__",
      role: "system",
      content: `[Agent Memory]
${memoryContent}`,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    return [memoryMessage, ...messages];
  }
  // --- Private helpers ---
  normalizeMessage(message) {
    return {
      ...message,
      id: message.id || crypto.randomUUID(),
      createdAt: message.createdAt || (/* @__PURE__ */ new Date()).toISOString(),
      metadata: message.metadata ?? {}
    };
  }
  createUserMessage(text) {
    return {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  createAssistantMessage(text) {
    return {
      id: crypto.randomUUID(),
      role: "assistant",
      content: text,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
};

// src/tool/registry.ts
var InMemoryToolRegistry = class {
  tools = /* @__PURE__ */ new Map();
  register(tool) {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }
  get(name) {
    return this.tools.get(name);
  }
  list() {
    return [...this.tools.values()];
  }
};

// src/tool/executor.ts
var ToolExecutor = class {
  constructor(registry, middleware, backendResolver) {
    this.registry = registry;
    this.middleware = middleware;
    this.backendResolver = backendResolver;
  }
  async run(call, ctx) {
    const tool = this.registry.get(call.name);
    if (!tool) {
      throw new AgentError({
        code: "TOOL_NOT_FOUND",
        message: `Tool not found: ${call.name}`,
        metadata: { toolName: call.name, toolCallId: call.id }
      });
    }
    const beforeDecision = await this.middleware.runBeforeTool(ctx, call);
    if (beforeDecision.shouldStop) {
      return {
        type: "stopped",
        reason: "middleware_stop",
        tool,
        call,
        statePatches: beforeDecision.statePatch
      };
    }
    const backend = this.backendResolver ? await this.backendResolver.resolve(ctx, tool, call) : void 0;
    const toolResult = await tool.invoke(call.input, {
      runContext: ctx,
      toolCall: call,
      backend
    });
    const executionResult = {
      tool,
      call,
      output: toolResult
    };
    const afterDecision = await this.middleware.runAfterTool(ctx, executionResult);
    const statePatches = [...beforeDecision.statePatch, ...afterDecision.statePatch];
    return {
      type: "completed",
      result: executionResult,
      shouldStop: afterDecision.shouldStop,
      statePatches
    };
  }
};

// src/tool/local-backend.ts
import { execFile } from "child_process";
import { promisify } from "util";
var execFileAsync = promisify(execFile);
var LocalBackend = class {
  kind = "local";
  capabilities() {
    return {
      exec: true,
      filesystemRead: true,
      filesystemWrite: true,
      network: true
    };
  }
  async exec(command, opts) {
    try {
      const { stdout, stderr } = await execFileAsync("sh", ["-lc", command], {
        cwd: opts?.cwd,
        env: { ...process.env, ...opts?.env ?? {} },
        timeout: opts?.timeoutMs
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err;
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? String(err),
        exitCode: e.code === "ENOENT" ? 127 : 1
      };
    }
  }
  async readFile(path) {
    const fs = await import("fs/promises");
    return fs.readFile(path, "utf-8");
  }
  async writeFile(path, content) {
    const fs = await import("fs/promises");
    await fs.writeFile(path, content, "utf-8");
  }
  async listFiles(path) {
    const fs = await import("fs/promises");
    const entries = await fs.readdir(path, { withFileTypes: true });
    return Promise.all(
      entries.map(async (entry) => {
        const fullPath = `${path}/${entry.name}`;
        const stat = entry.isSymbolicLink() ? await fs.stat(fullPath) : await fs.lstat(fullPath);
        return {
          path: fullPath,
          isDirectory: stat.isDirectory(),
          size: stat.size,
          modifiedAt: stat.mtime.toISOString()
        };
      })
    );
  }
};

// src/tool/default-backend-resolver.ts
var DefaultBackendResolver = class {
  constructor(localBackend, sandboxBackend) {
    this.localBackend = localBackend;
    this.sandboxBackend = sandboxBackend;
  }
  async resolve(_ctx, tool, _call) {
    if (tool.capabilities?.includes("requires-exec")) {
      return this.sandboxBackend;
    }
    if (tool.capabilities?.includes("requires-filesystem-read") || tool.capabilities?.includes("requires-filesystem-write")) {
      return this.sandboxBackend;
    }
    return this.localBackend;
  }
};

// src/middleware/pipeline.ts
var MiddlewarePipeline = class {
  middlewares;
  constructor(middlewares = []) {
    this.middlewares = [...middlewares];
  }
  async runBeforeRun(ctx) {
    for (const mw of this.middlewares) {
      if (mw.beforeRun) {
        await mw.beforeRun(ctx);
      }
    }
  }
  async runBeforeModel(ctx, req) {
    let current = req;
    for (const mw of this.middlewares) {
      if (mw.beforeModel) {
        current = await mw.beforeModel(ctx, current);
      }
    }
    return current;
  }
  async runAfterModel(ctx, resp) {
    let current = resp;
    for (const mw of this.middlewares) {
      if (mw.afterModel) {
        current = await mw.afterModel(ctx, current);
      }
    }
    return current;
  }
  async runBeforeTool(ctx, call) {
    const patches = [];
    let shouldStop = false;
    for (const mw of this.middlewares) {
      if (mw.beforeTool) {
        const decision = await mw.beforeTool(ctx, call);
        if (decision) {
          if (decision.statePatch) {
            patches.push(decision.statePatch);
          }
          if (decision.stopCurrentStep) {
            shouldStop = true;
          }
        }
      }
    }
    return { statePatch: patches, shouldStop };
  }
  async runAfterTool(ctx, result) {
    const patches = [];
    let shouldStop = false;
    for (const mw of this.middlewares) {
      if (mw.afterTool) {
        const decision = await mw.afterTool(ctx, result);
        if (decision) {
          if (decision.statePatch) {
            patches.push(decision.statePatch);
          }
          if (decision.stopCurrentStep) {
            shouldStop = true;
          }
        }
      }
    }
    return { statePatch: patches, shouldStop };
  }
  async runOnError(ctx, error) {
    for (const mw of this.middlewares) {
      if (mw.onError) {
        try {
          await mw.onError(ctx, error);
        } catch {
        }
      }
    }
  }
  async runAfterRun(ctx, result) {
    for (const mw of this.middlewares) {
      if (mw.afterRun) {
        await mw.afterRun(ctx, result);
      }
    }
  }
};

// src/policy.ts
var AllowAllPolicy = class {
  filterTools(_ctx, tools) {
    return tools;
  }
  canUseTool(_ctx, _tool, _input) {
    return true;
  }
};

// src/checkpoint.ts
var InMemoryCheckpointStore = class {
  records = /* @__PURE__ */ new Map();
  async load(runId) {
    return this.records.get(runId) ?? null;
  }
  async save(record) {
    this.records.set(record.runId, record);
  }
  async delete(runId) {
    this.records.delete(runId);
  }
};

// src/audit.ts
var ConsoleAuditLogger = class {
  log(event) {
    console.log(
      `[Audit:${event.type}] run=${event.runId}`,
      event.payload
    );
  }
};

// src/runtime.ts
var AgentRuntime = class {
  name;
  modelClient;
  model;
  toolList;
  pipeline;
  messageManager;
  policy;
  checkpoint;
  audit;
  systemPrompt;
  maxSteps;
  toolExecutor;
  registry;
  /** Track first checkpoint createdAt for resume. */
  firstCreatedAt;
  constructor(config) {
    this.name = config.name;
    this.modelClient = config.modelClient;
    this.model = config.model;
    this.toolList = config.tools;
    this.pipeline = config.pipeline ?? new MiddlewarePipeline();
    this.messageManager = config.messageManager ?? new DefaultMessageManager();
    this.policy = config.policy ?? new AllowAllPolicy();
    this.checkpoint = config.checkpoint;
    this.audit = config.audit;
    this.systemPrompt = config.systemPrompt;
    this.maxSteps = config.maxSteps;
    this.registry = new InMemoryToolRegistry();
    for (const tool of this.toolList) {
      this.registry.register(tool);
    }
    this.toolExecutor = new ToolExecutor(this.registry, this.pipeline, config.backendResolver);
  }
  async run(ctx) {
    try {
      const incoming = this.messageManager.normalizeIncoming(ctx.input);
      for (const msg of incoming) {
        ctx = this.patchState(ctx, { appendMessages: [msg] });
      }
      await this.pipeline.runBeforeRun(ctx);
      if (ctx.services.memory) {
        const loaded = await ctx.services.memory.load(ctx);
        ctx = { ...ctx, state: { ...ctx.state, memory: { ...ctx.state.memory, ...loaded } } };
      }
      await this.saveCheckpoint(ctx.state);
      this.emitAudit(ctx, {
        type: "run_started",
        payload: { stepCount: 0, inputType: ctx.input.inputText ? "text" : "messages" }
      });
      while (ctx.state.status === "running") {
        ctx = { ...ctx, state: { ...ctx.state, stepCount: ctx.state.stepCount + 1 } };
        if (ctx.state.stepCount > this.maxSteps) {
          ctx = this.patchState(ctx, {
            setStatus: "failed",
            setError: new AgentError({
              code: "MAX_STEPS_EXCEEDED",
              message: `Agent exceeded maximum steps (${this.maxSteps})`
            })
          });
          break;
        }
        const effectiveMessages = this.messageManager.buildEffectiveMessages(ctx);
        const allowedTools = await this.policy.filterTools(ctx, this.toolList);
        const toolDefs = allowedTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema ?? { type: "object", properties: {} }
        }));
        let modelRequest = {
          model: this.model,
          systemPrompt: this.systemPrompt,
          messages: effectiveMessages,
          tools: toolDefs
        };
        modelRequest = await this.pipeline.runBeforeModel(ctx, modelRequest);
        this.emitAudit(ctx, {
          type: "model_called",
          payload: {
            stepCount: ctx.state.stepCount,
            messageCount: modelRequest.messages.length,
            toolCount: modelRequest.tools.length
          }
        });
        let modelResponse = await this.modelClient.generate(modelRequest);
        this.emitAudit(ctx, {
          type: "model_returned",
          payload: { stepCount: ctx.state.stepCount, responseType: modelResponse.type }
        });
        modelResponse = await this.pipeline.runAfterModel(ctx, modelResponse);
        ctx = { ...ctx, state: { ...ctx.state, lastModelResponse: modelResponse } };
        if (modelResponse.type === "final") {
          ctx = this.patchState(
            ctx,
            {},
            (s) => this.messageManager.appendAssistantMessage(s, modelResponse.output)
          );
          ctx = this.patchState(ctx, { setStatus: "completed" });
          break;
        }
        if (modelResponse.type === "tool_calls") {
          ctx = this.patchState(
            ctx,
            {},
            (s) => this.messageManager.appendAssistantToolCallMessage(s, "", modelResponse.toolCalls)
          );
          let shouldStop = false;
          for (const call of modelResponse.toolCalls) {
            const tool = this.registry.get(call.name);
            if (!tool) {
              throw new AgentError({
                code: "TOOL_NOT_FOUND",
                message: `Tool not found: ${call.name}`,
                metadata: { toolName: call.name, toolCallId: call.id }
              });
            }
            const canUse = await this.policy.canUseTool(ctx, tool, call.input);
            if (!canUse) {
              throw new AgentError({
                code: "POLICY_DENIED",
                message: `Tool use denied by policy: ${call.name}`,
                metadata: { toolName: call.name, toolCallId: call.id }
              });
            }
            const needApproval = await this.policy.needApproval?.(ctx, tool, call.input);
            if (needApproval) {
              if (ctx.services.approval) {
                await ctx.services.approval.create({
                  id: crypto.randomUUID(),
                  runId: ctx.state.runId,
                  toolName: call.name,
                  input: call.input,
                  reason: `Tool "${call.name}" requires approval`,
                  createdAt: (/* @__PURE__ */ new Date()).toISOString()
                });
              }
              ctx = this.patchState(
                ctx,
                {},
                (s) => this.messageManager.appendAssistantMessage(s, `Operation "${call.name}" requires approval. Waiting for approval.`)
              );
              ctx = this.patchState(ctx, { setStatus: "waiting_approval" });
              this.emitAudit(ctx, {
                type: "approval_requested",
                payload: { toolName: call.name, toolCallId: call.id }
              });
              await this.saveCheckpoint(ctx.state);
              shouldStop = true;
              break;
            }
            this.emitAudit(ctx, {
              type: "tool_called",
              payload: { stepCount: ctx.state.stepCount, toolName: call.name, toolCallId: call.id }
            });
            const execResult = await this.toolExecutor.run(call, ctx);
            if (execResult.type === "stopped") {
              for (const patch of execResult.statePatches) {
                ctx = this.patchState(ctx, patch);
              }
              shouldStop = true;
              break;
            }
            const { result: toolResult } = execResult;
            for (const patch of execResult.statePatches) {
              ctx = this.patchState(ctx, patch);
            }
            if (toolResult.output.statePatch) {
              ctx = this.patchState(ctx, toolResult.output.statePatch);
            }
            let outputContent = toolResult.output.content;
            if (this.policy.redactOutput) {
              const redacted = await this.policy.redactOutput(ctx, outputContent);
              if (redacted !== void 0) {
                outputContent = redacted;
              }
            }
            ctx = this.patchState(
              ctx,
              {},
              (s) => this.messageManager.appendToolResultMessage(
                s,
                toolResult.tool.name,
                toolResult.call.id,
                outputContent
              )
            );
            ctx = {
              ...ctx,
              state: {
                ...ctx.state,
                lastToolCall: call,
                lastToolResult: toolResult.output
              }
            };
            this.emitAudit(ctx, {
              type: "tool_succeeded",
              payload: { toolName: call.name, toolCallId: call.id }
            });
            await this.saveCheckpoint(ctx.state);
            if (execResult.shouldStop) {
              shouldStop = true;
              break;
            }
          }
          if (shouldStop) break;
          continue;
        }
        ctx = this.patchState(
          ctx,
          {},
          (s) => this.messageManager.appendAssistantMessage(
            s,
            modelResponse.output ?? ""
          )
        );
        ctx = this.patchState(ctx, {
          setStatus: "failed",
          setError: new AgentError({
            code: "SYSTEM_ERROR",
            message: `Unexpected model response type: ${modelResponse.type}`
          })
        });
        break;
      }
      const result = {
        runId: ctx.state.runId,
        status: ctx.state.status,
        state: ctx.state
      };
      if (ctx.state.lastModelResponse?.type === "final") {
        result.output = ctx.state.lastModelResponse.output;
      }
      if (ctx.state.error) {
        result.error = ctx.state.error;
      }
      await this.pipeline.runAfterRun(ctx, result);
      if (ctx.services.memory?.save) {
        await ctx.services.memory.save(ctx, ctx.state.memory);
      }
      await this.saveCheckpoint(ctx.state);
      const finalStatus = ctx.state.status;
      this.emitAudit(ctx, {
        type: isTerminalStatus(finalStatus) && finalStatus === "completed" ? "run_completed" : "run_failed",
        payload: {
          stepCount: ctx.state.stepCount,
          messageCount: ctx.state.messages.length
        }
      });
      return result;
    } catch (error) {
      const agentError = error instanceof AgentError ? error : new AgentError({
        code: "SYSTEM_ERROR",
        message: error instanceof Error ? error.message : "Unknown error",
        cause: error
      });
      ctx = {
        ...ctx,
        state: applyStatePatch(ctx.state, {
          setStatus: "failed",
          setError: agentError
        })
      };
      await this.pipeline.runOnError(ctx, agentError);
      await this.saveCheckpoint(ctx.state);
      this.emitAudit(ctx, {
        type: "run_failed",
        payload: { code: agentError.code, message: agentError.message }
      });
      return {
        runId: ctx.state.runId,
        status: "failed",
        error: agentError,
        state: ctx.state
      };
    }
  }
  // --- Helpers ---
  patchState(ctx, patch, extraTransform) {
    let state = applyStatePatch(ctx.state, patch);
    if (extraTransform) {
      state = extraTransform(state);
    }
    return { ...ctx, state };
  }
  async saveCheckpoint(state) {
    if (!this.checkpoint) return;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    if (!this.firstCreatedAt) {
      this.firstCreatedAt = now;
    }
    await this.checkpoint.save({
      runId: state.runId,
      state,
      createdAt: this.firstCreatedAt,
      updatedAt: now
    });
  }
  emitAudit(ctx, event) {
    if (!this.audit) return;
    this.audit.log({
      id: crypto.randomUUID(),
      runId: ctx.state.runId,
      ...event,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
  }
};

// src/base.ts
var EnterpriseAgentBase = class {
  // --- Virtual methods (optional override) ---
  getMiddlewares() {
    return [];
  }
  getPolicy() {
    return new AllowAllPolicy();
  }
  getMaxSteps() {
    return 12;
  }
  getCheckpointStore() {
    return void 0;
  }
  getAuditLogger() {
    return void 0;
  }
  getApprovalService() {
    return void 0;
  }
  getMemoryStore() {
    return void 0;
  }
  getBackendResolver() {
    return void 0;
  }
  getIdentity() {
    return {
      userId: "unknown",
      tenantId: "default",
      roles: []
    };
  }
  // --- Public API ---
  /**
   * Invoke the agent with the given input.
   */
  async invoke(input) {
    const ctx = await this.createRunContext(input);
    const runtime = await this.createRuntime(ctx);
    return runtime.run(ctx);
  }
  /**
   * Resume a previously interrupted run from its checkpoint.
   */
  async resume(runId, payload) {
    const checkpoint = this.getCheckpointStore();
    if (!checkpoint) {
      throw new Error("CheckpointStore is required for resume");
    }
    const record = await checkpoint.load(runId);
    if (!record) {
      throw new Error(`Checkpoint not found: ${runId}`);
    }
    const ctx = await this.createResumeContext(record, payload);
    const runtime = await this.createRuntime(ctx);
    return runtime.run(ctx);
  }
  // --- Protected helpers ---
  async createRunContext(input) {
    const runId = crypto.randomUUID();
    const identity = this.getIdentity();
    const state = {
      runId,
      messages: input.messages ?? [],
      scratchpad: {},
      memory: {},
      stepCount: 0,
      status: "running"
    };
    const services = this.buildServices();
    return {
      input,
      identity,
      state,
      services,
      metadata: input.metadata ?? {}
    };
  }
  async createResumeContext(record, payload) {
    const input = {};
    if (payload) input.metadata = payload;
    return {
      input,
      identity: this.getIdentity(),
      state: {
        ...record.state,
        status: "running"
      },
      services: this.buildServices(),
      metadata: payload ?? {}
    };
  }
  buildServices() {
    const services = {};
    const checkpoint = this.getCheckpointStore();
    if (checkpoint) services.checkpoint = checkpoint;
    const audit = this.getAuditLogger();
    if (audit) services.audit = audit;
    const approval = this.getApprovalService();
    if (approval) services.approval = approval;
    const memory = this.getMemoryStore();
    if (memory) services.memory = memory;
    return services;
  }
  async createRuntime(ctx) {
    const pipeline = new MiddlewarePipeline(this.getMiddlewares());
    const checkpoint = this.getCheckpointStore();
    const audit = this.getAuditLogger();
    const backendResolver = this.getBackendResolver();
    const config = {
      name: this.getName(),
      modelClient: this.getModelClient(),
      model: this.getModelName(),
      tools: await this.getTools(ctx),
      pipeline,
      policy: this.getPolicy(),
      ...checkpoint ? { checkpoint } : {},
      ...audit ? { audit } : {},
      systemPrompt: await this.getSystemPrompt(ctx),
      maxSteps: this.getMaxSteps(),
      ...backendResolver ? { backendResolver } : {}
    };
    return new AgentRuntime(config);
  }
};
export {
  AgentError,
  AgentRuntime,
  AllowAllPolicy,
  ConsoleAuditLogger,
  DefaultBackendResolver,
  DefaultMessageManager,
  EnterpriseAgentBase,
  InMemoryCheckpointStore,
  InMemoryToolRegistry,
  LocalBackend,
  MiddlewarePipeline,
  ToolExecutor,
  appendMessages,
  applyMessagePatch,
  applyStatePatch,
  isTerminalStatus,
  patchToolPairs,
  replaceMessages,
  shouldPause,
  validateMessageSequence
};
//# sourceMappingURL=index.js.map